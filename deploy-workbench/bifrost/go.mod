// The entrypoint wrapper that gives the oauth2-proxy sidecar Bifrost's admin
// Basic credential (deploy-workbench/bifrost/entrypoint.go). It is a separate
// module so the derived image can build it in a stage of its own, and it has
// no dependencies at all: everything below is the standard library.
//
// It is not part of the TypeScript projects; `npm test` and `tsc` never look
// here, and the Go tests run during the image build (`Dockerfile`,
// `go test ./...`), which is what keeps a wrapper that does not fail closed
// from ever being pushed.
module thegoodparty/ops/deploy-workbench/bifrost

go 1.26
