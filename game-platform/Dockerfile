FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/game-platform .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates git && addgroup -S gameplatform && adduser -S -G gameplatform gameplatform
WORKDIR /app
COPY --from=build /out/game-platform /app/game-platform
USER gameplatform
EXPOSE 8787
ENTRYPOINT ["/app/game-platform"]
