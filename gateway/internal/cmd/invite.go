package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"aosui/gateway/invite"
	"github.com/spf13/cobra"
)

type inviteFlags struct {
	agent, ref, prefill, instructionFile string
	lang, name, logoURL, accent          string
	title, message                       string
	expiresIn                            time.Duration
}

func newInviteCommand(streams Streams, dependencies Dependencies) *cobra.Command {
	options := inviteFlags{}
	command := &cobra.Command{
		Use:   "invite --agent NAME --ref REF [flags]",
		Short: "Create an expiring guest invitation",
		Long: `Create a signed bearer link for one Agent and conversation reference.

The command runs locally and does not contact the runtime. It reads the
signing key and public guest origin from AOS_GATEWAY_INVITE_SIGNING_KEY and
AOS_GATEWAY_GUEST_ORIGIN. Keep the printed link private: it is a reusable
bearer credential until it expires.

First-turn instructions are accepted only through --instruction-file; use - to
read them from stdin. All JWT claims, including the instruction, are readable
by the link recipient, although the instruction is not shown in the guest UI.`,
		Example: `  aos-gateway invite --agent interviewer --ref dan-2026 \
    --expires-in 24h --prefill "Hey, Almog sent me here!" \
    --instruction-file /secure/path/dan.txt --lang en

  printf 'Load the interview skill for Dan.' | \
    aos-gateway invite --agent interviewer --ref dan-2026 --instruction-file -`,
		Args: inviteArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runInvite(streams, dependencies, options)
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.agent, "agent", "", "Native Agent or Hermes profile name (required)")
	flags.StringVar(&options.ref, "ref", "", "Stable conversation reference (required)")
	flags.DurationVar(&options.expiresIn, "expires-in", 24*time.Hour, "Invitation lifetime")
	flags.StringVar(&options.prefill, "prefill", "", "Editable first-message draft")
	flags.StringVar(&options.instructionFile, "instruction-file", "", "First-turn instruction file, or - for stdin")
	flags.StringVar(&options.lang, "lang", "", "Default UI language: en or he")
	flags.StringVar(&options.name, "name", "", "Guest header name")
	flags.StringVar(&options.logoURL, "logo-url", "", "HTTPS guest logo URL")
	flags.StringVar(&options.accent, "accent", "", "Guest accent color, for example #2563eb")
	flags.StringVar(&options.title, "title", "", "Conversation title")
	flags.StringVar(&options.message, "message", "", "Visible welcome note")
	return command
}

func inviteArgs(command *cobra.Command, args []string) error {
	if len(args) == 0 {
		return nil
	}
	if args[0] == "inspect" {
		return fmt.Errorf("unknown command %q for %q", args[0], command.CommandPath())
	}
	return errors.New("positional arguments are not accepted")
}

func runInvite(streams Streams, dependencies Dependencies, flags inviteFlags) error {
	if strings.TrimSpace(flags.agent) == "" || strings.TrimSpace(flags.ref) == "" || flags.expiresIn <= 0 {
		return errors.New("--agent, --ref, and a positive --expires-in are required")
	}
	getenv := dependencies.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	auth, err := invite.New(getenv("AOS_GATEWAY_INVITE_SIGNING_KEY"), getenv("AOS_GATEWAY_GUEST_ORIGIN"))
	if err != nil {
		return err
	}
	instruction, err := readInstruction(flags.instructionFile, streams.In)
	if err != nil {
		return err
	}
	now := time.Now
	if dependencies.Now != nil {
		now = dependencies.Now
	}
	ui := &invite.UI{Lang: flags.lang, Name: flags.name, LogoURL: flags.logoURL, Accent: flags.accent, Title: flags.title, Message: flags.message}
	if *ui == (invite.UI{}) {
		ui = nil
	}
	link, err := invite.CreateLink(auth, now(), invite.LinkOptions{
		Agent: flags.agent, Ref: flags.ref, Lifetime: flags.expiresIn,
		Prefill: flags.prefill, Instruction: instruction, UI: ui,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(streams.Out, link)
	return err
}

func readInstruction(path string, stdin io.Reader) (string, error) {
	if path == "" {
		return "", nil
	}
	reader := stdin
	var file *os.File
	var err error
	if path != "-" {
		file, err = os.Open(path)
		if err != nil {
			return "", fmt.Errorf("read instruction: %w", err)
		}
		defer file.Close()
		reader = file
	}
	if reader == nil {
		return "", errors.New("read instruction: stdin is unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(reader, 2001))
	if err != nil {
		return "", fmt.Errorf("read instruction: %w", err)
	}
	if len(data) > 2000 {
		return "", errors.New("instruction exceeds 2000 bytes")
	}
	return strings.TrimSpace(string(data)), nil
}
