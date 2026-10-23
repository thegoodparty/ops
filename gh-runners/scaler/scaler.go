package main

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"
	"github.com/google/uuid"
)

const runnerStartedBy = "gh-runners"

type ecsAPI interface {
	RunTask(ctx context.Context, params *ecs.RunTaskInput, optFns ...func(*ecs.Options)) (*ecs.RunTaskOutput, error)
	StopTask(ctx context.Context, params *ecs.StopTaskInput, optFns ...func(*ecs.Options)) (*ecs.StopTaskOutput, error)
	DescribeTasks(ctx context.Context, params *ecs.DescribeTasksInput, optFns ...func(*ecs.Options)) (*ecs.DescribeTasksOutput, error)
	ListTasks(ctx context.Context, params *ecs.ListTasksInput, optFns ...func(*ecs.Options)) (*ecs.ListTasksOutput, error)
}

type jitConfigAPI interface {
	GenerateJitRunnerConfig(ctx context.Context, jitRunnerSetting *scaleset.RunnerScaleSetJitRunnerSetting, scaleSetID int) (*scaleset.RunnerScaleSetJitRunnerConfig, error)
}

type Scaler struct {
	runners          runnerState
	scaleSetID       int
	scaleSetName     string
	ecs              ecsAPI
	cluster          string
	taskDefinition   string
	capacityProvider string
	containerName    string
	jit              jitConfigAPI
	sessionClient    listener.Client
	minRunners       int
	maxRunners       int
	lastAssignedJobs int
	logger           *slog.Logger
}

func (s *Scaler) Scale(ctx context.Context, msg *scaleset.RunnerScaleSetMessage) error {
	if msg == nil {
		if _, err := s.HandleDesiredRunnerCount(ctx, s.lastAssignedJobs); err != nil {
			return fmt.Errorf("failed to handle desired runner count: %w", err)
		}
		return nil
	}

	if len(msg.JobAvailableMessages) > 0 {
		requestIDs := make([]int64, 0, len(msg.JobAvailableMessages))
		for _, job := range msg.JobAvailableMessages {
			requestIDs = append(requestIDs, job.RunnerRequestID)
		}
		if _, err := s.sessionClient.AcquireJobs(ctx, requestIDs); err != nil {
			return fmt.Errorf("failed to acquire jobs: %w", err)
		}
	}

	for _, jobStarted := range msg.JobStartedMessages {
		s.HandleJobStarted(ctx, jobStarted)
	}
	for _, jobCompleted := range msg.JobCompletedMessages {
		s.HandleJobCompleted(ctx, jobCompleted)
	}

	if msg.Statistics == nil {
		return nil
	}
	s.lastAssignedJobs = msg.Statistics.TotalAssignedJobs

	if _, err := s.HandleDesiredRunnerCount(ctx, msg.Statistics.TotalAssignedJobs); err != nil {
		return fmt.Errorf("failed to handle desired runner count: %w", err)
	}
	return nil
}

func (s *Scaler) HandleDesiredRunnerCount(ctx context.Context, count int) (int, error) {
	s.reconcile(ctx)

	currentCount := s.runners.count()
	targetRunnerCount := min(s.maxRunners, s.minRunners+count)
	if targetRunnerCount <= currentCount {
		return currentCount, nil
	}

	scaleUp := targetRunnerCount - currentCount
	s.logger.Info(
		"Scaling up runners",
		slog.Int("currentCount", currentCount),
		slog.Int("desiredCount", targetRunnerCount),
		slog.Int("scaleUp", scaleUp),
	)
	for range scaleUp {
		if _, err := s.startRunner(ctx); err != nil {
			return 0, fmt.Errorf("failed to start runner: %w", err)
		}
	}
	return s.runners.count(), nil
}

func (s *Scaler) reconcile(ctx context.Context) {
	tracked := s.runners.all()
	if len(tracked) == 0 {
		return
	}
	nameByArn := make(map[string]string, len(tracked))
	arns := make([]string, 0, len(tracked))
	for name, arn := range tracked {
		nameByArn[arn] = name
		arns = append(arns, arn)
	}

	for i := 0; i < len(arns); i += 100 {
		out, err := s.ecs.DescribeTasks(ctx, &ecs.DescribeTasksInput{
			Cluster: aws.String(s.cluster),
			Tasks:   arns[i:min(i+100, len(arns))],
		})
		if err != nil {
			s.logger.Warn("Failed to describe runner tasks, skipping reconcile", slog.String("error", err.Error()))
			return
		}
		for _, task := range out.Tasks {
			if aws.ToString(task.LastStatus) != "STOPPED" {
				continue
			}
			name := nameByArn[aws.ToString(task.TaskArn)]
			s.runners.remove(name)
			s.logger.Info(
				"Dropping stopped runner",
				slog.String("name", name),
				slog.String("taskArn", aws.ToString(task.TaskArn)),
				slog.String("stoppedReason", aws.ToString(task.StoppedReason)),
				slog.String("stopCode", string(task.StopCode)),
			)
		}
		for _, failure := range out.Failures {
			if aws.ToString(failure.Reason) != "MISSING" {
				continue
			}
			name := nameByArn[aws.ToString(failure.Arn)]
			s.runners.remove(name)
			s.logger.Info(
				"Dropping missing runner",
				slog.String("name", name),
				slog.String("taskArn", aws.ToString(failure.Arn)),
			)
		}
	}
}

func (s *Scaler) HandleJobStarted(ctx context.Context, jobInfo *scaleset.JobStarted) {
	s.logger.Info(
		"Job started",
		slog.Int64("runnerRequestId", jobInfo.RunnerRequestID),
		slog.String("jobId", jobInfo.JobID),
		slog.String("runnerName", jobInfo.RunnerName),
	)
	if !s.runners.markBusy(jobInfo.RunnerName) {
		s.logger.Warn("Job started on untracked runner", slog.String("runnerName", jobInfo.RunnerName))
	}
}

func (s *Scaler) HandleJobCompleted(ctx context.Context, jobInfo *scaleset.JobCompleted) {
	s.logger.Info(
		"Job completed",
		slog.Int64("runnerRequestId", jobInfo.RunnerRequestID),
		slog.String("jobId", jobInfo.JobID),
		slog.String("runnerName", jobInfo.RunnerName),
		slog.String("result", jobInfo.Result),
	)
	if jobInfo.RunnerName == "" {
		return
	}

	taskArn, ok := s.runners.markDone(jobInfo.RunnerName)
	if !ok {
		s.logger.Warn("Job completed on untracked runner", slog.String("runnerName", jobInfo.RunnerName))
		return
	}

	if _, err := s.ecs.StopTask(ctx, &ecs.StopTaskInput{
		Cluster: aws.String(s.cluster),
		Task:    aws.String(taskArn),
		Reason:  aws.String("gh-runners: job completed"),
	}); err != nil {
		s.logger.Warn(
			"Failed to stop runner task after job completed",
			slog.String("runnerName", jobInfo.RunnerName),
			slog.String("taskArn", taskArn),
			slog.String("error", err.Error()),
		)
	}
}

func (s *Scaler) startRunner(ctx context.Context) (string, error) {
	name := fmt.Sprintf("%s-%s", s.scaleSetName, uuid.NewString()[:8])

	jit, err := s.jit.GenerateJitRunnerConfig(
		ctx,
		&scaleset.RunnerScaleSetJitRunnerSetting{Name: name},
		s.scaleSetID,
	)
	if err != nil {
		return "", fmt.Errorf("failed to generate JIT config: %w", err)
	}

	out, err := s.ecs.RunTask(ctx, &ecs.RunTaskInput{
		Cluster:        aws.String(s.cluster),
		TaskDefinition: aws.String(s.taskDefinition),
		CapacityProviderStrategy: []types.CapacityProviderStrategyItem{
			{CapacityProvider: aws.String(s.capacityProvider), Weight: 1},
		},
		Count:         aws.Int32(1),
		StartedBy:     aws.String(runnerStartedBy),
		PropagateTags: types.PropagateTagsNone,
		Tags: []types.Tag{
			{Key: aws.String("runner-name"), Value: aws.String(name)},
			{Key: aws.String("scale-set"), Value: aws.String(s.scaleSetName)},
		},
		Overrides: &types.TaskOverride{
			ContainerOverrides: []types.ContainerOverride{
				{
					Name: aws.String(s.containerName),
					Environment: []types.KeyValuePair{
						{Name: aws.String("ACTIONS_RUNNER_INPUT_JITCONFIG"), Value: aws.String(jit.EncodedJITConfig)},
					},
				},
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to run runner task: %w", err)
	}
	if len(out.Failures) > 0 {
		return "", fmt.Errorf(
			"run task failed for runner %s: %s: %s",
			name,
			aws.ToString(out.Failures[0].Reason),
			aws.ToString(out.Failures[0].Detail),
		)
	}
	if len(out.Tasks) != 1 {
		return "", fmt.Errorf("run task returned %d tasks for runner %s", len(out.Tasks), name)
	}

	taskArn := aws.ToString(out.Tasks[0].TaskArn)
	s.runners.addIdle(name, taskArn)
	s.logger.Info("Started runner", slog.String("name", name), slog.String("taskArn", taskArn))
	return name, nil
}

func (s *Scaler) adopt(ctx context.Context) error {
	paginator := ecs.NewListTasksPaginator(s.ecs, &ecs.ListTasksInput{
		Cluster:       aws.String(s.cluster),
		StartedBy:     aws.String(runnerStartedBy),
		DesiredStatus: types.DesiredStatusRunning,
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("failed to list runner tasks: %w", err)
		}
		if len(page.TaskArns) == 0 {
			continue
		}
		out, err := s.ecs.DescribeTasks(ctx, &ecs.DescribeTasksInput{
			Cluster: aws.String(s.cluster),
			Tasks:   page.TaskArns,
			Include: []types.TaskField{types.TaskFieldTags},
		})
		if err != nil {
			return fmt.Errorf("failed to describe runner tasks: %w", err)
		}
		for _, task := range out.Tasks {
			tags := make(map[string]string, len(task.Tags))
			for _, tag := range task.Tags {
				tags[aws.ToString(tag.Key)] = aws.ToString(tag.Value)
			}
			if tags["scale-set"] != s.scaleSetName {
				continue
			}
			taskArn := aws.ToString(task.TaskArn)
			name := tags["runner-name"]
			if name == "" {
				s.logger.Warn("Skipping runner task without runner-name tag", slog.String("taskArn", taskArn))
				continue
			}
			s.runners.addBusy(name, taskArn)
			s.logger.Info("Adopted runner", slog.String("name", name), slog.String("taskArn", taskArn))
		}
	}
	return nil
}

var _ listener.Scaler = (*Scaler)(nil)

type runnerState struct {
	mu   sync.Mutex
	idle map[string]string
	busy map[string]string
}

func (r *runnerState) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.idle) + len(r.busy)
}

func (r *runnerState) all() map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	all := make(map[string]string, len(r.idle)+len(r.busy))
	for name, taskArn := range r.idle {
		all[name] = taskArn
	}
	for name, taskArn := range r.busy {
		all[name] = taskArn
	}
	return all
}

func (r *runnerState) markBusy(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.busy[name]; ok {
		return true
	}
	taskArn, ok := r.idle[name]
	if !ok {
		return false
	}
	delete(r.idle, name)
	r.busy[name] = taskArn
	return true
}

func (r *runnerState) markDone(name string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if taskArn, ok := r.busy[name]; ok {
		delete(r.busy, name)
		return taskArn, true
	}
	if taskArn, ok := r.idle[name]; ok {
		delete(r.idle, name)
		return taskArn, true
	}
	return "", false
}

func (r *runnerState) remove(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.idle, name)
	delete(r.busy, name)
}

func (r *runnerState) addIdle(name, taskArn string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.idle[name] = taskArn
}

func (r *runnerState) addBusy(name, taskArn string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.busy[name] = taskArn
}
