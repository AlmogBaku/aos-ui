package cmd

import (
	"context"
	"os"

	gateway "aosui/gateway"
	"github.com/spf13/cobra"
)

type serveFunc func(context.Context, gateway.Config) error

func newServeCommand(dependencies Dependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "Run operator and guest listeners",
		Long: `Serve the existing AOS UI on two listeners for one selected runtime.

The operator listener serves the regular UI and same-origin native forwarding.
The guest listener serves only invited chat and its restricted API. Both bind to
loopback by default. Supply public HTTPS with an external reverse proxy; this
helper does not provision TLS.

Environment:
  AOS_GATEWAY_RUNTIME              hermes or opencode (required)
  AOS_GATEWAY_UPSTREAM             fixed native HTTP origin (required)
  AOS_GATEWAY_INVITE_SIGNING_KEY   32 random base64url-encoded bytes (required)
  AOS_GATEWAY_GUEST_ORIGIN         public HTTPS guest origin (required)
  AOS_GATEWAY_DIST                 frontend build directory (default dist)
  AOS_GATEWAY_OPERATOR_ADDR        operator listener (default 127.0.0.1:8080)
  AOS_GATEWAY_GUEST_ADDR           guest listener (default 127.0.0.1:8081)
  AOS_GATEWAY_HERMES_TOKEN         Hermes Desktop Session token
  AOS_GATEWAY_OPENCODE_DIRECTORY   fixed OpenCode working directory
  AOS_GATEWAY_OPENCODE_USERNAME    optional native Basic auth username
  AOS_GATEWAY_OPENCODE_PASSWORD    optional native Basic auth password`,
		Example: `  AOS_GATEWAY_RUNTIME=hermes \
  AOS_GATEWAY_UPSTREAM=http://127.0.0.1:9119 \
  AOS_GATEWAY_HERMES_TOKEN="$HERMES_SESSION_TOKEN" \
  aos-gateway serve`,
		Args: noPositionalArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			getenv := dependencies.Getenv
			if getenv == nil {
				getenv = os.Getenv
			}
			runner := dependencies.Serve
			if runner == nil {
				runner = gateway.Serve
			}
			return runner(command.Context(), configFromEnvironment(getenv))
		},
	}
}

func configFromEnvironment(getenv func(string) string) gateway.Config {
	config := gateway.Config{
		Runtime: getenv("AOS_GATEWAY_RUNTIME"), Upstream: getenv("AOS_GATEWAY_UPSTREAM"),
		InviteSigningKey: getenv("AOS_GATEWAY_INVITE_SIGNING_KEY"), GuestOrigin: getenv("AOS_GATEWAY_GUEST_ORIGIN"),
		Dist: getenv("AOS_GATEWAY_DIST"), OperatorAddress: getenv("AOS_GATEWAY_OPERATOR_ADDR"), GuestAddress: getenv("AOS_GATEWAY_GUEST_ADDR"),
		HermesToken: getenv("AOS_GATEWAY_HERMES_TOKEN"),
		OpenCode: gateway.OpenCodeConfig{
			Directory: getenv("AOS_GATEWAY_OPENCODE_DIRECTORY"), Username: getenv("AOS_GATEWAY_OPENCODE_USERNAME"), Password: getenv("AOS_GATEWAY_OPENCODE_PASSWORD"),
		},
	}
	if config.Dist == "" {
		config.Dist = "dist"
	}
	if config.OperatorAddress == "" {
		config.OperatorAddress = "127.0.0.1:8080"
	}
	if config.GuestAddress == "" {
		config.GuestAddress = "127.0.0.1:8081"
	}
	return config
}
