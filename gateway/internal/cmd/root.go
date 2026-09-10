// Package cmd defines the aos-gateway command-line interface.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/spf13/cobra"
)

type Streams struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

func noPositionalArgs(_ *cobra.Command, args []string) error {
	if len(args) != 0 {
		return errors.New("positional arguments are not accepted")
	}
	return nil
}

type Dependencies struct {
	Getenv func(string) string
	Now    func() time.Time
	Serve  serveFunc
}

func Execute(ctx context.Context, args []string, streams Streams, dependencies Dependencies) int {
	root := newRootCommand(streams, dependencies)
	root.SetArgs(args)
	if err := root.ExecuteContext(ctx); err != nil {
		hint := "aos-gateway --help"
		if len(args) > 1 && args[0] == "invite" && args[1] == "inspect" {
			hint = "aos-gateway invite inspect --help"
		} else if len(args) > 0 && (args[0] == "invite" || args[0] == "serve") {
			hint = "aos-gateway " + args[0] + " --help"
		}
		fmt.Fprintf(streams.Err, "Error: %v\nRun '%s' for usage.\n", err, hint)
		return 1
	}
	return 0
}

func newRootCommand(streams Streams, dependencies Dependencies) *cobra.Command {
	root := &cobra.Command{
		Use:           "aos-gateway",
		Short:         "Serve AOS UI and create restricted guest invitations",
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
	}
	root.SetIn(streams.In)
	root.SetOut(streams.Out)
	root.SetErr(streams.Err)
	root.AddCommand(
		newInviteCommand(streams, dependencies),
		newServeCommand(dependencies),
	)
	return root
}
