package server

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

type OperatorConfig struct{ Runtime, Upstream, Directory, Dist string }

const operatorOpenCodeDirectory = "/__aos_opencode__"

func NewOperator(c OperatorConfig) (http.Handler, error) {
	if c.Runtime != "hermes" && c.Runtime != "opencode" && c.Runtime != "openclaw" {
		return nil, errors.New("runtime must be hermes, opencode, or openclaw")
	}
	u, err := url.Parse(c.Upstream)
	if err != nil || u == nil {
		return nil, errors.New("invalid upstream URL")
	}
	validScheme := u.Scheme == "http" || u.Scheme == "https" || (c.Runtime == "openclaw" && (u.Scheme == "ws" || u.Scheme == "wss"))
	if u.Host == "" || !validScheme || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid upstream URL")
	}
	if u.Scheme == "ws" {
		u.Scheme = "http"
	}
	if u.Scheme == "wss" {
		u.Scheme = "https"
	}
	if c.Runtime == "opencode" && c.Directory == "" {
		return nil, errors.New("OpenCode directory required")
	}
	prefix := "/" + c.Runtime
	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Path = strings.TrimPrefix(p.In.URL.Path, prefix)
			if p.Out.URL.Path == "" {
				p.Out.URL.Path = "/"
			}
			p.Out.URL.RawPath = ""
			p.SetURL(u)
			if c.Runtime == "opencode" {
				query := p.Out.URL.Query()
				query.Set("directory", c.Directory)
				p.Out.URL.RawQuery = query.Encode()
			}
			// Native login/token cookies pass through; invitation credentials never do.
			p.Out.Header.Del("Cookie")
			for _, cookie := range p.In.Cookies() {
				if cookie.Name != cookieName {
					p.Out.AddCookie(cookie)
				}
			}
			if p.In.Header.Get("Origin") != "" {
				p.Out.Header.Set("Origin", u.Scheme+"://"+u.Host)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			if location := response.Header.Get("Location"); strings.HasPrefix(location, "/login") {
				response.Header.Set("Location", prefix+location)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) { failure(w, 502, "upstream-unavailable") },
	}
	files := staticFiles(c.Dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin := scheme + "://" + r.Host
		if r.URL.Path == "/runtime-config.json" && r.Method == http.MethodGet {
			config := map[string]string{"mode": c.Runtime, "baseUrl": prefix}
			if c.Runtime == "opencode" {
				// The browser contract requires an absolute directory-shaped value,
				// but the native path remains server-owned and is restored by Rewrite.
				config["directory"] = operatorOpenCodeDirectory
			}
			jsonResponse(w, 200, config)
			return
		}
		if r.URL.Path == prefix || strings.HasPrefix(r.URL.Path, prefix+"/") {
			// Prevent cross-site native mutations and WebSocket handshakes through
			// the operator forwarding listener. Native authentication remains required.
			if requestOrigin := r.Header.Get("Origin"); requestOrigin != "" && requestOrigin != origin {
				failure(w, 403, "origin")
				return
			}
			proxy.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/hermes/") || strings.HasPrefix(r.URL.Path, "/opencode/") || strings.HasPrefix(r.URL.Path, "/openclaw/") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/" && r.URL.Path != "/logo-adaptive.svg" && !strings.HasPrefix(r.URL.Path, "/assets/") {
			if len(strings.Split(strings.Trim(r.URL.Path, "/"), "/")) > 2 {
				http.NotFound(w, r)
				return
			}
			r = r.Clone(r.Context())
			cloned := *r.URL
			cloned.Path = "/"
			r.URL = &cloned
		}
		files.ServeHTTP(w, r)
	}), nil
}
