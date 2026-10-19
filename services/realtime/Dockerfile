# Build context: services/realtime (CGO off, static binary, distroless nonroot runtime).
FROM golang:1.26.9-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/realtime ./cmd/realtime

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/realtime /realtime
# 256 MiB instance: keep the Go heap below it so the GC works before Cloud Run kills the container.
ENV GOMEMLIMIT=200MiB \
    PORT=8080
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/realtime"]
