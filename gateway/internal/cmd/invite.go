package cmd

import (
	"crypto/rand"
	"encoding/base64"
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
	agent, ref, prefill, instruction string
	lang, name, logoURL, accent      string
	title, message                   string
	expiresIn                        time.Duration
}

func newInviteCommand(streams Streams, dependencies Dependencies) *cobra.Command {
	options := inviteFlags{}
	command := &cobra.Command{
		Use:   "invite --agent NAME --instruction TEXT [flags]",
		Short: "Create an expiring guest invitation",
		Long: `Create a signed bearer link for one Agent and conversation reference.

The command runs locally and does not contact the runtime. It reads the
signing key and public guest origin from AOS_GATEWAY_INVITE_SIGNING_KEY and
AOS_GATEWAY_GUEST_ORIGIN. Keep the printed link private: it is a reusable
bearer credential until it expires.

First-turn instructions are supplied inline. All JWT claims, including the
instruction, are readable by the link recipient, although the instruction is
not shown in the guest UI.`,
		Example: `  aos-gateway invite --agent interviewer \
    --expires-in 24h --prefill "Hey, Almog sent me here!" \
    --instruction 'Load the interview skill for Dan.' --lang en

	  aos-gateway invite --agent interviewer --ref returning-guest \
	    --instruction 'Continue the scheduled interview.'`,
		Args: inviteArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runInvite(streams, dependencies, options)
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.agent, "agent", "", "Native Agent or Hermes profile name (required)")
	flags.StringVar(&options.ref, "ref", "", "Stable conversation reference; generated when omitted")
	flags.DurationVar(&options.expiresIn, "expires-in", 24*time.Hour, "Invitation lifetime")
	flags.StringVar(&options.prefill, "prefill", "", "Editable first-message draft")
	flags.StringVar(&options.instruction, "instruction", "", "Inline first-turn Agent instruction (required)")
	flags.StringVar(&options.lang, "lang", "", "Default UI language: en or he")
	flags.StringVar(&options.name, "name", "", "Guest header name")
	flags.StringVar(&options.logoURL, "logo", "", "HTTPS guest logo URL")
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
	agent := strings.TrimSpace(flags.agent)
	instruction := strings.TrimSpace(flags.instruction)
	if agent == "" || instruction == "" || flags.expiresIn <= 0 {
		return errors.New("--agent, --instruction, and a positive --expires-in are required")
	}
	ref := strings.TrimSpace(flags.ref)
	if ref == "" {
		data := make([]byte, 16)
		random := dependencies.Random
		if random == nil {
			random = rand.Reader
		}
		if _, err := io.ReadFull(random, data); err != nil {
			return fmt.Errorf("generate invitation reference: %w", err)
		}
		ref = base64.RawURLEncoding.EncodeToString(data)
	}
	getenv := dependencies.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	auth, err := invite.New(getenv("AOS_GATEWAY_INVITE_SIGNING_KEY"), getenv("AOS_GATEWAY_GUEST_ORIGIN"))
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
		Agent: agent, Ref: ref, Lifetime: flags.expiresIn,
		Prefill: flags.prefill, Instruction: instruction, UI: ui,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(streams.Out, link)
	return err
}
