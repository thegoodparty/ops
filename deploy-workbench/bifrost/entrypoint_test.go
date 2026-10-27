package main

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

// testEnv is a stand-in for the process environment: getenv and setenv over a
// map, so the assertions are about run's behaviour rather than os.
type testEnv map[string]string

func (e testEnv) getenv(key string) string { return e[key] }

func (e testEnv) setenv(key, value string) error {
	e[key] = value
	return nil
}

func (e testEnv) environ() []string {
	out := make([]string, 0, len(e))
	for key, value := range e {
		out = append(out, key+"="+value)
	}
	return out
}

// recordingExec records the call it was given and returns err. It never starts
// a process, which is the point: the test asserts the argv and the environment
// the proxy would inherit.
type recordingExec struct {
	called  bool
	argv0   string
	argv    []string
	environ []string
	err     error
}

func (r *recordingExec) exec(argv0 string, argv []string, environ []string) error {
	r.called = true
	r.argv0 = argv0
	r.argv = argv
	r.environ = environ
	return r.err
}

func TestAuthorizationValue(t *testing.T) {
	t.Run("encodes the user and password as Basic credentials", func(t *testing.T) {
		value, err := authorizationValue("bifrost-admin", "s3cret!")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		// The literal is base64("bifrost-admin:s3cret!"), so this fails if the
		// username, the separator or the encoding changes.
		const expected = "Basic Ymlmcm9zdC1hZG1pbjpzM2NyZXQh"
		if value != expected {
			t.Fatalf("got %q, want %q", value, expected)
		}

		// And the other direction, so a wrong literal cannot make both sides
		// agree: what Bifrost decodes has to be exactly `user:password`.
		encoded := strings.TrimPrefix(value, "Basic ")
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatalf("the value is not valid base64: %v", err)
		}
		if string(decoded) != "bifrost-admin:s3cret!" {
			t.Fatalf("decoded %q, want %q", string(decoded), "bifrost-admin:s3cret!")
		}
	})

	t.Run("refuses a missing username", func(t *testing.T) {
		if _, err := authorizationValue("", "s3cret!"); err == nil {
			t.Fatal("an empty username must fail the container, not start the proxy")
		}
	})

	t.Run("refuses a missing password", func(t *testing.T) {
		if _, err := authorizationValue("bifrost-admin", ""); err == nil {
			t.Fatal("an empty password must fail the container, not start the proxy")
		}
	})

	t.Run("never echoes the credential in its error", func(t *testing.T) {
		_, err := authorizationValue("bifrost-admin", "")
		if err == nil {
			t.Fatal("expected an error")
		}
		if strings.Contains(err.Error(), "bifrost-admin") {
			t.Fatalf("the error names the username: %v", err)
		}
	})
}

func TestRun(t *testing.T) {
	alphaArgs := []string{"--alpha-config=/etc/oauth2-proxy/alpha-config.yaml"}
	credential := map[string]string{
		UsernameEnv: "bifrost-admin",
		PasswordEnv: "s3cret!",
	}

	t.Run("exports the header and execs oauth2-proxy", func(t *testing.T) {
		env := testEnv{}
		for key, value := range credential {
			env[key] = value
		}
		exec := &recordingExec{}

		if err := run(alphaArgs, env.getenv, env.setenv, env.environ, exec.exec); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		const expected = "Basic Ymlmcm9zdC1hZG1pbjpzM2NyZXQh"
		if env[AuthorizationEnv] != expected {
			t.Fatalf("%s is %q, want %q", AuthorizationEnv, env[AuthorizationEnv], expected)
		}
		if !exec.called {
			t.Fatal("oauth2-proxy was never started")
		}
		if exec.argv0 != proxyBinary {
			t.Fatalf("argv0 is %q, want %q", exec.argv0, proxyBinary)
		}
		want := append([]string{proxyBinary}, alphaArgs...)
		if strings.Join(exec.argv, " ") != strings.Join(want, " ") {
			t.Fatalf("argv is %v, want %v", exec.argv, want)
		}
		// The exported value has to be in the environment the proxy inherits,
		// not only in ours: oauth2-proxy reads it with os.Getenv after exec.
		found := false
		for _, entry := range exec.environ {
			if entry == AuthorizationEnv+"="+expected {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s is not in the exec environment: %v", AuthorizationEnv, exec.environ)
		}
	})

	t.Run("fails closed without the admin username", func(t *testing.T) {
		env := testEnv{PasswordEnv: credential[PasswordEnv]}
		exec := &recordingExec{}

		err := run(alphaArgs, env.getenv, env.setenv, env.environ, exec.exec)
		if err == nil {
			t.Fatal("a task with no admin username must not start a proxy")
		}
		if exec.called {
			t.Fatal("oauth2-proxy was started without a credential to inject")
		}
		if _, ok := env[AuthorizationEnv]; ok {
			t.Fatalf("%s was exported with nothing to put in it", AuthorizationEnv)
		}
	})

	t.Run("fails closed without the admin password", func(t *testing.T) {
		env := testEnv{UsernameEnv: credential[UsernameEnv]}
		exec := &recordingExec{}

		err := run(alphaArgs, env.getenv, env.setenv, env.environ, exec.exec)
		if err == nil {
			t.Fatal("a task with no admin password must not start a proxy")
		}
		if exec.called {
			t.Fatal("oauth2-proxy was started without a credential to inject")
		}
	})

	t.Run("fails closed when the credential cannot be exported", func(t *testing.T) {
		env := testEnv{}
		for key, value := range credential {
			env[key] = value
		}
		exec := &recordingExec{}
		setenv := func(string, string) error { return errors.New("no environment") }

		if err := run(alphaArgs, env.getenv, setenv, env.environ, exec.exec); err == nil {
			t.Fatal("a credential that cannot be exported must fail the container")
		}
		if exec.called {
			t.Fatal("oauth2-proxy was started without the header value in its environment")
		}
	})

	t.Run("refuses to start without the alpha configuration", func(t *testing.T) {
		// Without --alpha-config oauth2-proxy never injects the header, and the
		// admin surface would silently be back to the shared password prompt.
		for _, args := range [][]string{nil, {"--config=/etc/oauth2-proxy/oauth2-proxy.cfg"}} {
			env := testEnv{}
			for key, value := range credential {
				env[key] = value
			}
			exec := &recordingExec{}

			if err := run(args, env.getenv, env.setenv, env.environ, exec.exec); err == nil {
				t.Fatalf("args %v: the proxy must not start without %s", args, alphaConfigFlag)
			}
			if exec.called {
				t.Fatalf("args %v: oauth2-proxy was started without the alpha configuration", args)
			}
		}
	})

	t.Run("accepts the flag in its two-argument form", func(t *testing.T) {
		env := testEnv{}
		for key, value := range credential {
			env[key] = value
		}
		exec := &recordingExec{}
		args := []string{"--alpha-config", "/etc/oauth2-proxy/alpha-config.yaml"}

		if err := run(args, env.getenv, env.setenv, env.environ, exec.exec); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !exec.called {
			t.Fatal("oauth2-proxy was never started")
		}
	})

	t.Run("reports an exec failure", func(t *testing.T) {
		env := testEnv{}
		for key, value := range credential {
			env[key] = value
		}
		exec := &recordingExec{err: errors.New("exec failed")}

		if err := run(alphaArgs, env.getenv, env.setenv, env.environ, exec.exec); err == nil {
			t.Fatal("an exec failure must exit non-zero")
		}
	})
}
