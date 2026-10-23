package main

import (
	"context"
	"fmt"
	"log/slog"
	"testing"

	"github.com/actions/scaleset"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"
)

type fakeECS struct {
	runTaskInputs  []*ecs.RunTaskInput
	runTaskFailure *types.Failure
	stopped        []string
	stopTaskErr    error
	statusByArn    map[string]string
	listedArns     []string
	tagsByArn      map[string]map[string]string
}

func (f *fakeECS) RunTask(ctx context.Context, in *ecs.RunTaskInput, _ ...func(*ecs.Options)) (*ecs.RunTaskOutput, error) {
	f.runTaskInputs = append(f.runTaskInputs, in)
	if f.runTaskFailure != nil {
		return &ecs.RunTaskOutput{Failures: []types.Failure{*f.runTaskFailure}}, nil
	}
	arn := fmt.Sprintf("arn:aws:ecs:us-west-2:1:task/c/%d", len(f.runTaskInputs))
	return &ecs.RunTaskOutput{Tasks: []types.Task{{TaskArn: aws.String(arn)}}}, nil
}

func (f *fakeECS) StopTask(ctx context.Context, in *ecs.StopTaskInput, _ ...func(*ecs.Options)) (*ecs.StopTaskOutput, error) {
	f.stopped = append(f.stopped, aws.ToString(in.Task))
	return &ecs.StopTaskOutput{}, f.stopTaskErr
}

func (f *fakeECS) DescribeTasks(ctx context.Context, in *ecs.DescribeTasksInput, _ ...func(*ecs.Options)) (*ecs.DescribeTasksOutput, error) {
	out := &ecs.DescribeTasksOutput{}
	for _, arn := range in.Tasks {
		status, ok := f.statusByArn[arn]
		if !ok {
			out.Failures = append(out.Failures, types.Failure{Arn: aws.String(arn), Reason: aws.String("MISSING")})
			continue
		}
		task := types.Task{TaskArn: aws.String(arn), LastStatus: aws.String(status), StoppedReason: aws.String("Essential container exited")}
		for k, v := range f.tagsByArn[arn] {
			task.Tags = append(task.Tags, types.Tag{Key: aws.String(k), Value: aws.String(v)})
		}
		out.Tasks = append(out.Tasks, task)
	}
	return out, nil
}

func (f *fakeECS) ListTasks(ctx context.Context, in *ecs.ListTasksInput, _ ...func(*ecs.Options)) (*ecs.ListTasksOutput, error) {
	return &ecs.ListTasksOutput{TaskArns: f.listedArns}, nil
}

type fakeJIT struct{}

func (fakeJIT) GenerateJitRunnerConfig(ctx context.Context, setting *scaleset.RunnerScaleSetJitRunnerSetting, scaleSetID int) (*scaleset.RunnerScaleSetJitRunnerConfig, error) {
	return &scaleset.RunnerScaleSetJitRunnerConfig{EncodedJITConfig: "jit-for-" + setting.Name}, nil
}

func newTestScaler(f *fakeECS, minRunners, maxRunners int) *Scaler {
	if f.statusByArn == nil {
		f.statusByArn = map[string]string{}
	}
	return &Scaler{
		logger:           slog.New(slog.DiscardHandler),
		runners:          runnerState{idle: map[string]string{}, busy: map[string]string{}},
		scaleSetID:       7,
		scaleSetName:     "gp-ecs",
		ecs:              f,
		cluster:          "runners",
		taskDefinition:   "gh-runner",
		capacityProvider: "runners-cp",
		containerName:    "runner",
		jit:              fakeJIT{},
		minRunners:       minRunners,
		maxRunners:       maxRunners,
	}
}

func markRunning(f *fakeECS) {
	for i := range f.runTaskInputs {
		f.statusByArn[fmt.Sprintf("arn:aws:ecs:us-west-2:1:task/c/%d", i+1)] = "RUNNING"
	}
}

func TestHandleDesiredRunnerCountScalesWithinMinMax(t *testing.T) {
	f := &fakeECS{}
	s := newTestScaler(f, 1, 3)

	count, err := s.HandleDesiredRunnerCount(context.Background(), 0)
	if err != nil || count != 1 {
		t.Fatalf("min runners: count=%d err=%v, want 1", count, err)
	}
	markRunning(f)

	count, err = s.HandleDesiredRunnerCount(context.Background(), 5)
	if err != nil || count != 3 {
		t.Fatalf("max runners: count=%d err=%v, want 3", count, err)
	}
	if len(f.runTaskInputs) != 3 {
		t.Fatalf("RunTask calls = %d, want 3", len(f.runTaskInputs))
	}

	in := f.runTaskInputs[0]
	if aws.ToString(in.Cluster) != "runners" || aws.ToString(in.TaskDefinition) != "gh-runner" || aws.ToInt32(in.Count) != 1 {
		t.Fatalf("unexpected RunTask target: %+v", in)
	}
	if len(in.CapacityProviderStrategy) != 1 || aws.ToString(in.CapacityProviderStrategy[0].CapacityProvider) != "runners-cp" || in.CapacityProviderStrategy[0].Weight != 1 {
		t.Fatalf("unexpected capacity provider strategy: %+v", in.CapacityProviderStrategy)
	}
	if aws.ToString(in.StartedBy) != "gh-runners" || in.PropagateTags != types.PropagateTagsNone {
		t.Fatalf("unexpected startedBy/propagateTags: %q %q", aws.ToString(in.StartedBy), in.PropagateTags)
	}
	tags := map[string]string{}
	for _, tag := range in.Tags {
		tags[aws.ToString(tag.Key)] = aws.ToString(tag.Value)
	}
	if tags["scale-set"] != "gp-ecs" || tags["runner-name"] == "" {
		t.Fatalf("unexpected tags: %v", tags)
	}
	override := in.Overrides.ContainerOverrides[0]
	if aws.ToString(override.Name) != "runner" ||
		aws.ToString(override.Environment[0].Name) != "ACTIONS_RUNNER_INPUT_JITCONFIG" ||
		aws.ToString(override.Environment[0].Value) != "jit-for-"+tags["runner-name"] {
		t.Fatalf("unexpected container override: %+v", override)
	}
}

func TestStartRunnerTreatsRunTaskFailuresAsError(t *testing.T) {
	f := &fakeECS{runTaskFailure: &types.Failure{Reason: aws.String("RESOURCE:MEMORY")}}
	s := newTestScaler(f, 0, 10)

	if _, err := s.HandleDesiredRunnerCount(context.Background(), 1); err == nil {
		t.Fatal("expected error from RunTask failures")
	}
	if s.runners.count() != 0 {
		t.Fatalf("failed runner was tracked: count=%d", s.runners.count())
	}
}

func TestReconcileDropsStoppedAndMissingTasks(t *testing.T) {
	f := &fakeECS{statusByArn: map[string]string{"arn-running": "RUNNING", "arn-stopped": "STOPPED"}}
	s := newTestScaler(f, 0, 10)
	s.runners.addBusy("running", "arn-running")
	s.runners.addIdle("crashed", "arn-stopped")
	s.runners.addIdle("gone", "arn-missing")

	count, err := s.HandleDesiredRunnerCount(context.Background(), 2)
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v, want 2", count, err)
	}
	if len(f.runTaskInputs) != 1 {
		t.Fatalf("RunTask calls = %d, want 1 replacement", len(f.runTaskInputs))
	}
	all := s.runners.all()
	if _, ok := all["crashed"]; ok {
		t.Fatal("stopped runner still tracked")
	}
	if _, ok := all["gone"]; ok {
		t.Fatal("missing runner still tracked")
	}
}

func TestAdoptKeepsOnlyThisScaleSetsTasksAsBusy(t *testing.T) {
	f := &fakeECS{
		listedArns: []string{"arn-a", "arn-b", "arn-c"},
		statusByArn: map[string]string{
			"arn-a": "RUNNING",
			"arn-b": "RUNNING",
			"arn-c": "RUNNING",
		},
		tagsByArn: map[string]map[string]string{
			"arn-a": {"scale-set": "gp-ecs", "runner-name": "gp-ecs-a"},
			"arn-b": {"scale-set": "other", "runner-name": "other-b"},
			"arn-c": {"scale-set": "gp-ecs"},
		},
	}
	s := newTestScaler(f, 0, 10)

	if err := s.adopt(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(s.runners.busy) != 1 || s.runners.busy["gp-ecs-a"] != "arn-a" || len(s.runners.idle) != 0 {
		t.Fatalf("unexpected adopted state: busy=%v idle=%v", s.runners.busy, s.runners.idle)
	}

	count, err := s.HandleDesiredRunnerCount(context.Background(), 1)
	if err != nil || count != 1 || len(f.runTaskInputs) != 0 {
		t.Fatalf("adopted runner not counted: count=%d err=%v runTasks=%d", count, err, len(f.runTaskInputs))
	}
}

func TestHandleJobCompletedStopsRunnerTask(t *testing.T) {
	f := &fakeECS{stopTaskErr: fmt.Errorf("task already stopped")}
	s := newTestScaler(f, 0, 10)
	s.runners.addIdle("gp-ecs-a", "arn-a")

	s.HandleJobStarted(context.Background(), &scaleset.JobStarted{RunnerName: "gp-ecs-a"})
	if s.runners.busy["gp-ecs-a"] != "arn-a" {
		t.Fatal("runner not marked busy")
	}

	s.HandleJobCompleted(context.Background(), &scaleset.JobCompleted{RunnerName: "gp-ecs-a"})
	if len(f.stopped) != 1 || f.stopped[0] != "arn-a" {
		t.Fatalf("StopTask calls = %v, want [arn-a]", f.stopped)
	}
	if s.runners.count() != 0 {
		t.Fatalf("runner still tracked after completion: count=%d", s.runners.count())
	}
}

func TestUnknownRunnerNamesDoNotPanic(t *testing.T) {
	f := &fakeECS{}
	s := newTestScaler(f, 0, 10)

	err := s.Scale(context.Background(), &scaleset.RunnerScaleSetMessage{
		JobStartedMessages:   []*scaleset.JobStarted{{RunnerName: "nope"}},
		JobCompletedMessages: []*scaleset.JobCompleted{{RunnerName: "nope"}, {RunnerName: ""}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.stopped) != 0 {
		t.Fatalf("StopTask called for unknown runner: %v", f.stopped)
	}
}

func TestScaleNilMessageReusesLastAssignedJobs(t *testing.T) {
	f := &fakeECS{statusByArn: map[string]string{}}
	s := newTestScaler(f, 0, 10)

	if err := s.Scale(context.Background(), &scaleset.RunnerScaleSetMessage{
		Statistics: &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 1},
	}); err != nil {
		t.Fatal(err)
	}
	f.statusByArn["arn:aws:ecs:us-west-2:1:task/c/1"] = "STOPPED"

	if err := s.Scale(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if len(f.runTaskInputs) != 2 || s.runners.count() != 1 {
		t.Fatalf("crashed runner not replaced on idle poll: runTasks=%d count=%d", len(f.runTaskInputs), s.runners.count())
	}
}
