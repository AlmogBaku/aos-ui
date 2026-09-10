package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Only the root and Vite's assets are public. Unknown native/API routes never
// fall through to index.html, and config is generated separately without secrets.
func staticFiles(dist string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if dist == "" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join(dist, "index.html"))
			return
		}
		if (r.URL.Path != "/logo-adaptive.svg" && !strings.HasPrefix(r.URL.Path, "/assets/")) || strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(dist, filepath.FromSlash(r.URL.Path))
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, p)
	})
}
