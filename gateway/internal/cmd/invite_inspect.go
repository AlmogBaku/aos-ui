package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"aosui/gateway/invite"
	"github.com/spf13/cobra"
)

const maxInviteInputBytes = invite.MaxTokenBytes + 2048

func newInviteInspectCommand(streams Streams, dependencies Dependencies) *cobra.Command {
	var linkFile string
	command := &cobra.Command{
		Use:   "inspect --link-file PATH",
		Short: "Decrypt and inspect a guest invitation locally",
		Long: `Decrypt a guest invitation and print its complete claims as formatted JSON.

The input may be a full invitation URL or a raw encrypted token. Use - to read
from stdin. This command runs locally and does not contact a runtime.

The output includes private first-turn instructions. Handle it as sensitive
data. Decryption requires AOS_GATEWAY_INVITE_KEY and validates the invitation
against AOS_GATEWAY_GUEST_ORIGIN. Expired or tampered invitations are rejected.`,
		Example: `  aos-gateway invite inspect --link-file ./invite-link.txt

  pbpaste | aos-gateway invite inspect --link-file -`,
		Args: noPositionalArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runInviteInspect(streams, dependencies, linkFile)
		},
	}
	command.Flags().StringVar(&linkFile, "link-file", "", "Invite URL/token file, or - for stdin (required)")
	return command
}

func runInviteInspect(streams Streams, dependencies Dependencies, linkFile string) error {
	if linkFile == "" {
		return errors.New("--link-file is required")
	}
	getenv := dependencies.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	auth, err := invite.New(getenv("AOS_GATEWAY_INVITE_KEY"), getenv("AOS_GATEWAY_GUEST_ORIGIN"))
	if err != nil {
		return err
	}
	raw, err := readInviteInput(linkFile, streams.In)
	if err != nil {
		return err
	}
	token, err := inviteToken(raw, auth.Origin())
	if err != nil {
		return err
	}
	claims, err := auth.Decrypt(token)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(streams.Out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(claims)
}

func readInviteInput(path string, stdin io.Reader) (string, error) {
	reader := stdin
	var file *os.File
	var err error
	if path != "-" {
		file, err = os.Open(path)
		if err != nil {
			return "", fmt.Errorf("read invite: %w", err)
		}
		defer file.Close()
		reader = file
	}
	if reader == nil {
		return "", errors.New("read invite: stdin is unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxInviteInputBytes+1))
	if err != nil {
		return "", fmt.Errorf("read invite: %w", err)
	}
	if len(data) > maxInviteInputBytes {
		return "", errors.New("invite input is too large")
	}
	if value := strings.TrimSpace(string(data)); value != "" {
		return value, nil
	}
	return "", errors.New("invite input is empty")
}

func inviteToken(raw, expectedOrigin string) (string, error) {
	if !strings.Contains(raw, "://") {
		return raw, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", invite.ErrInvalid
	}
	origin := parsed.Scheme + "://" + parsed.Host
	if origin != expectedOrigin || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" {
		return "", invite.ErrInvalid
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || len(fragment) != 1 || fragment.Get("invite") == "" {
		return "", invite.ErrInvalid
	}
	return fragment.Get("invite"), nil
}
