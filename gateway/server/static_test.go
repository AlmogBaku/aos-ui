package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticFilesServesTheDeclaredAOSIconOnly(t *testing.T) {
	dist := t.TempDir()
	if err := os.WriteFile(filepath.Join(dist, "logo-adaptive.svg"), []byte("<svg/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "private.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := staticFiles(dist)

	icon := httptest.NewRecorder()
	handler.ServeHTTP(icon, httptest.NewRequest(http.MethodGet, "/logo-adaptive.svg", nil))
	if icon.Code != http.StatusOK || icon.Body.String() != "<svg/>" {
		t.Fatalf("icon response = %d %q", icon.Code, icon.Body.String())
	}

	private := httptest.NewRecorder()
	handler.ServeHTTP(private, httptest.NewRequest(http.MethodGet, "/private.txt", nil))
	if private.Code != http.StatusNotFound {
		t.Fatalf("private response = %d", private.Code)
	}
}
