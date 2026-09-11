// Package gateway composes native runtime adapters and runs the optional AOS UI helper.
package gateway

// Config contains all server-side settings for one gateway deployment.
type Config struct {
	Runtime          string
	Upstream         string
	Dist             string
	OperatorAddress  string
	GuestAddress     string
	InviteSigningKey string
	GuestOrigin      string
	HermesToken      string
	OpenCode         OpenCodeConfig
	OpenClaw         OpenClawConfig
}

type OpenCodeConfig struct {
	Directory string
	Username  string
	Password  string
}

type OpenClawConfig struct {
	Token string
}
