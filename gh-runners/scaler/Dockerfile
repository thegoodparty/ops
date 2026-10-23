FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/scaler .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/scaler /scaler
USER nonroot:nonroot
ENTRYPOINT ["/scaler"]
