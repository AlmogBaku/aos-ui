package main

import (
	"context"
	"crypto/rand"
	"os"
	"os/signal"
	"syscall"
	"time"

	gateway "aosui/gateway"
	"aosui/gateway/internal/cmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(cmd.Execute(ctx, os.Args[1:], cmd.Streams{
		In: os.Stdin, Out: os.Stdout, Err: os.Stderr,
	}, cmd.Dependencies{
		Getenv: os.Getenv, Now: time.Now, Random: rand.Reader, Serve: gateway.Serve,
	}))
}
