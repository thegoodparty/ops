package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/google/uuid"
)

type Config struct {
	GitHubConfigURL      string
	ScaleSetName         string
	Labels               []string
	RunnerGroup          string
	MinRunners           int
	MaxRunners           int
	GitHubApp            scaleset.GitHubAppAuth
	Token                string
	Cluster              string
	RunnerTaskDefinition string
	CapacityProvider     string
	ContainerName        string
	Region               string
}

func loadConfig() (Config, error) {
	envOr := func(key, fallback string) string {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
		return fallback
	}

	c := Config{
		GitHubConfigURL:      envOr("GITHUB_CONFIG_URL", ""),
		ScaleSetName:         envOr("SCALESET_NAME", ""),
		RunnerGroup:          envOr("RUNNER_GROUP", "Default"),
		Token:                envOr("GITHUB_TOKEN", ""),
		Cluster:              envOr("ECS_CLUSTER", ""),
		RunnerTaskDefinition: envOr("RUNNER_TASK_DEFINITION", ""),
		CapacityProvider:     envOr("RUNNER_CAPACITY_PROVIDER", ""),
		ContainerName:        envOr("RUNNER_CONTAINER_NAME", "runner"),
		Region:               envOr("AWS_REGION", ""),
		GitHubApp: scaleset.GitHubAppAuth{
			ClientID:   envOr("GITHUB_APP_CLIENT_ID", ""),
			PrivateKey: os.Getenv("GITHUB_APP_PRIVATE_KEY"),
		},
	}

	for _, label := range strings.Split(envOr("SCALESET_LABELS", c.ScaleSetName), ",") {
		if label = strings.TrimSpace(label); label != "" {
			c.Labels = append(c.Labels, label)
		}
	}

	var err error
	if c.MinRunners, err = strconv.Atoi(envOr("MIN_RUNNERS", "0")); err != nil {
		return c, fmt.Errorf("invalid MIN_RUNNERS: %w", err)
	}
	if c.MaxRunners, err = strconv.Atoi(envOr("MAX_RUNNERS", "10")); err != nil {
		return c, fmt.Errorf("invalid MAX_RUNNERS: %w", err)
	}
	if v := envOr("GITHUB_APP_INSTALLATION_ID", ""); v != "" {
		if c.GitHubApp.InstallationID, err = strconv.ParseInt(v, 10, 64); err != nil {
			return c, fmt.Errorf("invalid GITHUB_APP_INSTALLATION_ID: %w", err)
		}
	}

	required := map[string]string{
		"GITHUB_CONFIG_URL":        c.GitHubConfigURL,
		"SCALESET_NAME":            c.ScaleSetName,
		"ECS_CLUSTER":              c.Cluster,
		"RUNNER_TASK_DEFINITION":   c.RunnerTaskDefinition,
		"RUNNER_CAPACITY_PROVIDER": c.CapacityProvider,
		"AWS_REGION":               c.Region,
	}
	for key, value := range required {
		if value == "" {
			return c, fmt.Errorf("%s is required", key)
		}
	}
	if c.MinRunners < 0 || c.MaxRunners < c.MinRunners {
		return c, fmt.Errorf("MIN_RUNNERS must be >= 0 and MAX_RUNNERS must be >= MIN_RUNNERS")
	}
	if c.Token == "" && c.GitHubApp.Validate() != nil {
		return c, fmt.Errorf("either GITHUB_APP_CLIENT_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN, are required")
	}
	return c, nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := run(ctx, logger); err != nil {
		logger.Error("Scaler exited", slog.String("error", err.Error()))
		os.Exit(1)
	}
	logger.Info("Scaler stopped")
}

func run(ctx context.Context, logger *slog.Logger) error {
	c, err := loadConfig()
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	systemInfo := scaleset.SystemInfo{
		System:    "gh-runners-ecs",
		Subsystem: "scaler",
		CommitSHA: "NA",
		Version:   "0.1.0",
	}

	var scalesetClient *scaleset.Client
	if c.GitHubApp.Validate() == nil {
		scalesetClient, err = scaleset.NewClientWithGitHubApp(scaleset.ClientWithGitHubAppConfig{
			GitHubConfigURL: c.GitHubConfigURL,
			GitHubAppAuth:   c.GitHubApp,
			SystemInfo:      systemInfo,
		})
	} else {
		scalesetClient, err = scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
			GitHubConfigURL:     c.GitHubConfigURL,
			PersonalAccessToken: c.Token,
			SystemInfo:          systemInfo,
		})
	}
	if err != nil {
		return fmt.Errorf("failed to create scaleset client: %w", err)
	}

	runnerGroupID := 1
	if !strings.EqualFold(c.RunnerGroup, scaleset.DefaultRunnerGroup) {
		runnerGroup, err := scalesetClient.GetRunnerGroupByName(ctx, c.RunnerGroup)
		if err != nil {
			return fmt.Errorf("failed to get runner group %q: %w", c.RunnerGroup, err)
		}
		runnerGroupID = runnerGroup.ID
	}

	labels := make([]scaleset.Label, len(c.Labels))
	for i, name := range c.Labels {
		labels[i] = scaleset.Label{Name: name}
	}
	desired := &scaleset.RunnerScaleSet{
		Name:          c.ScaleSetName,
		RunnerGroupID: runnerGroupID,
		Labels:        labels,
		RunnerSetting: scaleset.RunnerSetting{DisableUpdate: true},
	}

	scaleSet, err := scalesetClient.GetRunnerScaleSet(ctx, runnerGroupID, c.ScaleSetName)
	if err != nil {
		return fmt.Errorf("failed to get runner scale set: %w", err)
	}
	if scaleSet == nil {
		logger.Info("Creating runner scale set", slog.String("name", c.ScaleSetName), slog.Int("runnerGroupID", runnerGroupID))
		scaleSet, err = scalesetClient.CreateRunnerScaleSet(ctx, desired)
		if err != nil {
			return fmt.Errorf("failed to create runner scale set: %w", err)
		}
	} else {
		logger.Info("Updating runner scale set", slog.String("name", c.ScaleSetName), slog.Int("scaleSetID", scaleSet.ID))
		scaleSet, err = scalesetClient.UpdateRunnerScaleSet(ctx, scaleSet.ID, desired)
		if err != nil {
			return fmt.Errorf("failed to update runner scale set: %w", err)
		}
	}
	systemInfo.ScaleSetID = scaleSet.ID
	scalesetClient.SetSystemInfo(systemInfo)

	awsConfig, err := config.LoadDefaultConfig(ctx, config.WithRegion(c.Region))
	if err != nil {
		return fmt.Errorf("failed to load AWS config: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		hostname = uuid.NewString()
	}

	var sessionClient *scaleset.MessageSessionClient
	for attempt := 1; ; attempt++ {
		sessionClient, err = scalesetClient.MessageSessionClient(ctx, scaleSet.ID, hostname)
		if err == nil {
			break
		}
		if !errors.Is(err, scaleset.ConflictError) || attempt >= 18 {
			return fmt.Errorf("failed to create message session: %w", err)
		}
		logger.Warn("Message session held by another listener, retrying", slog.Int("attempt", attempt))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(10 * time.Second):
		}
	}
	defer sessionClient.Close(context.WithoutCancel(ctx))

	scaler := &Scaler{
		logger: logger.WithGroup("scaler"),
		runners: runnerState{
			idle: make(map[string]string),
			busy: make(map[string]string),
		},
		scaleSetID:       scaleSet.ID,
		scaleSetName:     c.ScaleSetName,
		ecs:              ecs.NewFromConfig(awsConfig),
		cluster:          c.Cluster,
		taskDefinition:   c.RunnerTaskDefinition,
		capacityProvider: c.CapacityProvider,
		containerName:    c.ContainerName,
		jit:              scalesetClient,
		sessionClient:    sessionClient,
		minRunners:       c.MinRunners,
		maxRunners:       c.MaxRunners,
	}

	if err := scaler.adopt(ctx); err != nil {
		return fmt.Errorf("failed to adopt existing runner tasks: %w", err)
	}

	l, err := listener.New(sessionClient, listener.Config{
		ScaleSetID: scaleSet.ID,
		MaxRunners: c.MaxRunners,
		Logger:     logger.WithGroup("listener"),
	})
	if err != nil {
		return fmt.Errorf("failed to create listener: %w", err)
	}

	logger.Info("Starting listener", slog.Int("scaleSetID", scaleSet.ID), slog.Any("labels", c.Labels))
	if err := l.Run(ctx, scaler); !errors.Is(err, context.Canceled) {
		return fmt.Errorf("listener run failed: %w", err)
	}
	return nil
}
