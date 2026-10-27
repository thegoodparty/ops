// Command bifrost-oauth2-entrypoint starts the Bifrost admin surface's
// oauth2-proxy with Bifrost's own admin login already satisfied.
//
// Bifrost OSS has no SSO, so its dashboard and management API keep a single
// admin username and password (`governance.auth_config` in
// `docs/bifrost-gateway.md`). oauth2-proxy gates the admin paths with Google
// SSO and the committed allowlist, and this wrapper is what stops the human
// from meeting Bifrost's login as a second prompt: it turns the admin
// credential the deployment already holds into the header value the baked
// alpha config injects upstream (`alpha-config.yaml`,
// `injectRequestHeaders`).
//
// The value is computed here, at container start, from the two keys the task
// definition injects from `bifrost/gateway` rather than stored a second time
// in Secrets Manager. A stored copy would be a second thing to rotate, and the
// failure mode when it drifts is silent: oauth2-proxy would forward a stale
// credential, Bifrost would answer 401, and every allowlisted human would meet
// the login form again with a password nobody has.
//
// Fail closed, in three places:
//
//  1. this wrapper exits non-zero when either input is missing or empty, so
//     the task fails to start rather than running a proxy that injects
//     nothing;
//  2. it refuses to start oauth2-proxy without `--alpha-config`, because
//     without that file oauth2-proxy ignores the injection entirely and the
//     admin surface quietly reverts to the shared password prompt;
//  3. oauth2-proxy itself validates the `fromEnv` source against a non-empty
//     environment variable before it will start
//     (`pkg/validation/common.go`, `validateSecretSourceEnv`, at the pinned
//     tag).
//
// It is a Go program rather than a shell script because the base image is
// `oauth2-proxy:v7.15.5`, which is built on `gcr.io/distroless/static:nonroot`:
// there is no `/bin/sh` and no coreutils in it to run a script with, and
// adding a shell to the container that holds the admin credential is the wrong
// direction. The binary is static, so the runtime image gains one executable
// and nothing else.
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"syscall"
)

const (
	// UsernameEnv and PasswordEnv are the two keys the task definition
	// injects into the sidecar from `bifrost/gateway`, the same values the
	// gateway container gets and `bootstrap.sh` claims the account with.
	// Renaming either is a change to `ecs.ts` and this file together;
	// `oauth2-proxy-image.test.ts` fails if they drift.
	UsernameEnv = "BIFROST_ADMIN_USERNAME"
	PasswordEnv = "BIFROST_ADMIN_PASSWORD"

	// AuthorizationEnv is the environment variable the baked alpha config
	// reads with `secretSource.fromEnv`. It is set by this wrapper and by
	// nothing else: the task definition must not define it, or a stale value
	// would be forwarded instead of the live credential.
	AuthorizationEnv = "BIFROST_ADMIN_AUTHORIZATION"

	// alphaConfigFlag is the flag the task definition passes. This wrapper
	// replaces the image's `ENTRYPOINT ["/bin/oauth2-proxy"]`, so the flag
	// arrives as an argument.
	alphaConfigFlag = "--alpha-config"

	// proxyBinary is the image's own entrypoint, which this wrapper execs.
	proxyBinary = "/bin/oauth2-proxy"
)

// authorizationValue renders the `Authorization` header value Bifrost's Basic
// login expects. Bifrost compares both halves, so the username is carried as
// given; the encoding is what every HTTP client does with a user and password.
func authorizationValue(username, password string) (string, error) {
	if username == "" {
		return "", fmt.Errorf("%s is not set: refusing to start a proxy that cannot inject Bifrost's admin credential", UsernameEnv)
	}
	if password == "" {
		return "", fmt.Errorf("%s is not set: refusing to start a proxy that cannot inject Bifrost's admin credential", PasswordEnv)
	}
	credential := username + ":" + password
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(credential)), nil
}

// hasAlphaConfig reports whether the proxy is being started with the alpha
// configuration that carries the header injection.
func hasAlphaConfig(args []string) bool {
	for _, arg := range args {
		if arg == alphaConfigFlag || strings.HasPrefix(arg, alphaConfigFlag+"=") {
			return true
		}
	}
	return false
}

// execFunc is os/exec's shape for a process replacement, narrow enough to
// substitute in a test.
type execFunc func(string, []string, []string) error

// run computes the credential, exports it to the environment oauth2-proxy will
// inherit, and replaces this process with oauth2-proxy. Everything is passed
// in rather than read from the process, so the behaviour a test asserts is the
// behaviour the binary has.
func run(
	args []string,
	getenv func(string) string,
	setenv func(string, string) error,
	environ func() []string,
	exec execFunc,
) error {
	if !hasAlphaConfig(args) {
		return fmt.Errorf("no %s flag: without the alpha configuration oauth2-proxy does not inject Bifrost's admin credential", alphaConfigFlag)
	}

	value, err := authorizationValue(getenv(UsernameEnv), getenv(PasswordEnv))
	if err != nil {
		return err
	}

	if err := setenv(AuthorizationEnv, value); err != nil {
		return fmt.Errorf("cannot export %s: %w", AuthorizationEnv, err)
	}

	argv := append([]string{proxyBinary}, args...)
	if err := exec(proxyBinary, argv, environ()); err != nil {
		return fmt.Errorf("cannot exec %s: %w", proxyBinary, err)
	}
	return nil
}

func main() {
	// A failed run prints the reason and nothing else: neither the username
	// nor the password nor the derived header value is ever logged, because
	// this container's stdout is a CloudWatch log stream.
	if err := run(os.Args[1:], os.Getenv, os.Setenv, os.Environ, syscall.Exec); err != nil {
		fmt.Fprintf(os.Stderr, "bifrost-oauth2-entrypoint: %v\n", err)
		os.Exit(1)
	}
}
