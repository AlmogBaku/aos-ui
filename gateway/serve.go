package gateway

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/hermes"
	"aosui/gateway/invite"
	"aosui/gateway/opencode"
	"aosui/gateway/server"
)

// Serve runs the operator and guest listeners until the context is cancelled or a listener fails.
func Serve(ctx context.Context, config Config) error {
	auth, err := invite.New(config.InviteKey, config.GuestOrigin)
	if err != nil {
		return err
	}
	adapter, err := newAdapter(config)
	if err != nil {
		return err
	}
	operator, err := server.NewOperator(server.OperatorConfig{
		Runtime: config.Runtime, Upstream: config.Upstream,
		Directory: config.OpenCode.Directory, Dist: config.Dist,
	})
	if err != nil {
		return err
	}
	return servePair(ctx, config.OperatorAddress, config.GuestAddress, operator, server.NewGuest(auth, adapter, config.Dist))
}

func newAdapter(config Config) (conversation.Adapter, error) {
	switch config.Runtime {
	case "hermes":
		return hermes.New(hermes.Config{BaseURL: config.Upstream, Token: config.HermesToken})
	case "opencode":
		return opencode.New(opencode.Config{
			BaseURL: config.Upstream, Directory: config.OpenCode.Directory,
			Username: config.OpenCode.Username, Password: config.OpenCode.Password,
		})
	default:
		return nil, errors.New("AOS_GATEWAY_RUNTIME must be hermes or opencode")
	}
}

func servePair(ctx context.Context, operatorAddress, guestAddress string, operator, guest http.Handler) error {
	operatorListener, err := net.Listen("tcp", operatorAddress)
	if err != nil {
		return fmt.Errorf("operator listener: %w", err)
	}
	defer operatorListener.Close()
	guestListener, err := net.Listen("tcp", guestAddress)
	if err != nil {
		return fmt.Errorf("guest listener: %w", err)
	}
	defer guestListener.Close()

	operatorServer := configuredServer(operator)
	guestServer := configuredServer(guest)
	errorsChannel := make(chan error, 2)
	go func() { errorsChannel <- operatorServer.Serve(operatorListener) }()
	go func() { errorsChannel <- guestServer.Serve(guestListener) }()
	var serveErr error
	select {
	case <-ctx.Done():
	case err := <-errorsChannel:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return errors.Join(serveErr, operatorServer.Shutdown(shutdownContext), guestServer.Shutdown(shutdownContext))
}

func configuredServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, IdleTimeout: 2 * time.Minute,
	}
}
