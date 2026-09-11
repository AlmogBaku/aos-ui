package openclaw

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const deviceStateVersion = 1

type deviceState struct {
	Version       int      `json:"version"`
	DeviceID      string   `json:"deviceId"`
	PublicKeyPEM  string   `json:"publicKeyPem"`
	PrivateKeyPEM string   `json:"privateKeyPem"`
	DeviceToken   string   `json:"deviceToken,omitempty"`
	Scopes        []string `json:"scopes,omitempty"`
}

func newDeviceState() (deviceState, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return deviceState{}, err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return deviceState{}, err
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return deviceState{}, err
	}
	fingerprint := sha256.Sum256(publicKey)
	return deviceState{
		Version: deviceStateVersion, DeviceID: hex.EncodeToString(fingerprint[:]),
		PublicKeyPEM:  string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})),
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})),
	}, nil
}

func (state deviceState) keys() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if (state.DeviceToken == "") != (len(state.Scopes) == 0) {
		return nil, nil, errors.New("invalid OpenClaw persisted device authority")
	}
	if state.DeviceToken != strings.TrimSpace(state.DeviceToken) {
		return nil, nil, errors.New("invalid OpenClaw persisted device token")
	}
	if state.DeviceToken != "" {
		granted := make(map[string]bool, len(state.Scopes))
		for _, scope := range state.Scopes {
			granted[scope] = true
		}
		for _, scope := range requiredScopes {
			if !granted[scope] {
				return nil, nil, fmt.Errorf("OpenClaw persisted device token missing required scope %s", scope)
			}
		}
	}
	publicBlock, rest := pem.Decode([]byte(state.PublicKeyPEM))
	if publicBlock == nil || publicBlock.Type != "PUBLIC KEY" || len(rest) != 0 {
		return nil, nil, errors.New("invalid OpenClaw device public key")
	}
	parsedPublic, err := x509.ParsePKIXPublicKey(publicBlock.Bytes)
	if err != nil {
		return nil, nil, errors.New("invalid OpenClaw device public key")
	}
	publicKey, ok := parsedPublic.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, nil, errors.New("invalid OpenClaw device public key")
	}
	privateBlock, rest := pem.Decode([]byte(state.PrivateKeyPEM))
	if privateBlock == nil || privateBlock.Type != "PRIVATE KEY" || len(rest) != 0 {
		return nil, nil, errors.New("invalid OpenClaw device private key")
	}
	parsedPrivate, err := x509.ParsePKCS8PrivateKey(privateBlock.Bytes)
	if err != nil {
		return nil, nil, errors.New("invalid OpenClaw device private key")
	}
	privateKey, ok := parsedPrivate.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize || !publicKey.Equal(privateKey.Public()) {
		return nil, nil, errors.New("OpenClaw device keypair mismatch")
	}
	fingerprint := sha256.Sum256(publicKey)
	if state.Version != deviceStateVersion || state.DeviceID != hex.EncodeToString(fingerprint[:]) {
		return nil, nil, errors.New("invalid OpenClaw device identity")
	}
	return publicKey, privateKey, nil
}

func readDeviceState(path string) (deviceState, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return deviceState{}, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return deviceState{}, errors.New("OpenClaw device state must be a regular 0600 file")
	}
	file, err := os.Open(path)
	if err != nil {
		return deviceState{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return deviceState{}, errors.New("OpenClaw device state changed while opening")
	}
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var state deviceState
	if err := decoder.Decode(&state); err != nil {
		return deviceState{}, errors.New("invalid OpenClaw device state")
	}
	if _, _, err := state.keys(); err != nil {
		return deviceState{}, err
	}
	return state, nil
}

func encodeDeviceState(state deviceState) ([]byte, error) {
	if _, _, err := state.keys(); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	return append(data, '\n'), err
}

func createDeviceState(path string, state deviceState) error {
	data, err := encodeDeviceState(state)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".openclaw-device-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryName, path); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func replaceDeviceState(path string, state deviceState) error {
	if _, err := readDeviceState(path); err != nil {
		return err
	}
	data, err := encodeDeviceState(state)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".openclaw-device-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func loadOrCreateDeviceState(path string) (deviceState, error) {
	if !filepath.IsAbs(path) {
		return deviceState{}, errors.New("OpenClaw device state path must be absolute")
	}
	state, err := readDeviceState(path)
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return deviceState{}, err
	}
	state, err = newDeviceState()
	if err != nil {
		return deviceState{}, err
	}
	if err := createDeviceState(path, state); err != nil {
		if existing, readErr := readDeviceState(path); readErr == nil {
			return existing, nil
		}
		return deviceState{}, fmt.Errorf("create OpenClaw device state: %w", err)
	}
	return state, nil
}

func (state deviceState) publicKeyBase64URL() (string, error) {
	publicKey, _, err := state.keys()
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(publicKey), nil
}

func (state deviceState) sign(payload string) (string, error) {
	_, privateKey, err := state.keys()
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(payload))), nil
}
