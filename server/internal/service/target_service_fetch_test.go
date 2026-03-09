package service

import (
	"all-monitor/server/internal/model"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeFetchHTTPMode(t *testing.T) {
	cases := map[string]string{
		"":        fetchHTTPModeAuto,
		"auto":    fetchHTTPModeAuto,
		"h1":      fetchHTTPModeH1,
		"http1":   fetchHTTPModeH1,
		"http1.1": fetchHTTPModeH1,
		"h2":      fetchHTTPModeH2,
		"http2":   fetchHTTPModeH2,
		"weird":   fetchHTTPModeAuto,
	}
	for in, want := range cases {
		if got := normalizeFetchHTTPMode(in); got != want {
			t.Fatalf("mode %q => %q, want %q", in, got, want)
		}
	}
}

func TestShouldTryAlternateProtocol(t *testing.T) {
	if !shouldTryAlternateProtocol(fetchHTTPModeAuto, errors.New("net/http: timeout awaiting response headers")) {
		t.Fatal("expected timeout to trigger protocol switch")
	}
	if !shouldTryAlternateProtocol(fetchHTTPModeAuto, errors.New("net/http: HTTP/1.x transport connection broken: malformed HTTP response")) {
		t.Fatal("expected protocol mismatch to trigger protocol switch")
	}
	if shouldTryAlternateProtocol(fetchHTTPModeH2, errors.New("timeout")) {
		t.Fatal("expected fixed mode to disable protocol switch")
	}
	if shouldTryAlternateProtocol(fetchHTTPModeAuto, errors.New("http_status_403")) {
		t.Fatal("expected http status errors not to trigger switch")
	}
	if !shouldTryAlternateProtocol(fetchHTTPModeAuto, errors.New("Get \"https://example.com\": EOF")) {
		t.Fatal("expected EOF to trigger protocol switch")
	}
}

func TestMarkFetchProtocolFailureOnEOF(t *testing.T) {
	svc := &TargetService{}
	host := "example.com"
	svc.markFetchProtocolFailure(host, fetchHTTPModeH2, errors.New("Get \"https://example.com\": EOF"))
	plan := svc.fetchProtocolPlan(host, fetchHTTPModeAuto)
	if len(plan) != 2 || plan[0] != fetchHTTPModeH1 {
		t.Fatalf("expected h2 to be penalized after EOF, got %v", plan)
	}
}

func TestIsFetchProtocolMismatch(t *testing.T) {
	if !isFetchProtocolMismatch(errors.New("net/http: HTTP/1.x transport connection broken: malformed HTTP response")) {
		t.Fatal("expected malformed response to be treated as mismatch")
	}
	if isFetchProtocolMismatch(errors.New("context deadline exceeded")) {
		t.Fatal("expected timeout not to be treated as mismatch")
	}
}

func TestClassifyE2EFailureTLSHandshake(t *testing.T) {
	stage, reason := classifyE2EFailure("fatal get https://www.google.com/generate_204: tls: first record does not look like a tls handshake")
	if stage != "proxy_handshake" || reason != "proxy_handshake_failed" {
		t.Fatalf("unexpected classify result: %s %s", stage, reason)
	}
}

func TestShouldFallbackToBaselineOnE2EFailure(t *testing.T) {
	node := model.SubscriptionNode{Protocol: "vless"}
	baseline := subscriptionBaselineResult{Success: true, TLSMS: 900, LatencyMS: 900}
	if !shouldFallbackToBaselineOnE2EFailure(node, baseline, subscriptionE2EResult{FailReason: "proxy_handshake_failed"}) {
		t.Fatal("expected proxy handshake failure to fallback to baseline")
	}
	if !shouldFallbackToBaselineOnE2EFailure(node, baseline, subscriptionE2EResult{FailReason: "tls: first record does not look like a tls handshake"}) {
		t.Fatal("expected tls first record error to fallback to baseline")
	}
	if shouldFallbackToBaselineOnE2EFailure(node, baseline, subscriptionE2EResult{FailReason: "unsupported protocol"}) {
		t.Fatal("expected unsupported parse failure not to fallback")
	}
	if shouldFallbackToBaselineOnE2EFailure(model.SubscriptionNode{Protocol: "ss"}, baseline, subscriptionE2EResult{FailReason: "proxy_handshake_failed"}) {
		t.Fatal("expected ss not to fallback to baseline")
	}
}

func TestBuildSingBoxOutboundFromMapTUICVersion(t *testing.T) {
	node := model.SubscriptionNode{Protocol: "tuic", Server: "example.com", Port: 443}
	_, err := buildSingBoxOutboundFromMap(node, map[string]any{
		"type":     "tuic",
		"server":   "example.com",
		"port":     443,
		"uuid":     "11111111-1111-1111-1111-111111111111",
		"password": "pwd",
		"version":  4,
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported tuic version") {
		t.Fatalf("expected unsupported tuic version error, got %v", err)
	}
}

func TestBuildSingBoxOutboundFromMapHysteria2(t *testing.T) {
	node := model.SubscriptionNode{Protocol: "hysteria2", Server: "hk3.dexlos.com", Port: 20400}
	out, err := buildSingBoxOutboundFromMap(node, map[string]any{
		"type":             "hysteria2",
		"server":           "hk3.dexlos.com",
		"port":             20400,
		"password":         "secret",
		"sni":              "hk3.dexlos.com",
		"skip-cert-verify": false,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := out["type"]; got != "hysteria2" {
		t.Fatalf("unexpected type: %v", got)
	}
	if got := out["password"]; got != "secret" {
		t.Fatalf("unexpected password: %v", got)
	}
}

func TestShouldSkipBaselineProbe(t *testing.T) {
	if !shouldSkipBaselineProbe(model.SubscriptionNode{Protocol: "hysteria2"}) {
		t.Fatal("expected hysteria2 baseline skip")
	}
	if !shouldSkipBaselineProbe(model.SubscriptionNode{Protocol: "tuic"}) {
		t.Fatal("expected tuic baseline skip")
	}
	if shouldSkipBaselineProbe(model.SubscriptionNode{Protocol: "vless"}) {
		t.Fatal("expected vless not to skip baseline")
	}
}

func TestParseServerPortFromClashServerField(t *testing.T) {
	h, p, ok := parseServerPortFromClashServerField("example.com:8443")
	if !ok || h != "example.com" || p != 8443 {
		t.Fatalf("unexpected parse result: ok=%v host=%s port=%d", ok, h, p)
	}
	h, p, ok = parseServerPortFromClashServerField("[2001:db8::1]:443")
	if !ok || h != "2001:db8::1" || p != 443 {
		t.Fatalf("unexpected ipv6 parse result: ok=%v host=%s port=%d", ok, h, p)
	}
}

func TestParseClashProxyPort(t *testing.T) {
	if got := parseClashProxyPort(map[string]any{"port": 443}); got != 443 {
		t.Fatalf("expected explicit port, got %d", got)
	}
	if got := parseClashProxyPort(map[string]any{"ports": "20400-20599"}); got != 20400 {
		t.Fatalf("expected range first port, got %d", got)
	}
	if got := parseClashProxyPort(map[string]any{"ports": ""}); got != 0 {
		t.Fatalf("expected zero for empty ports, got %d", got)
	}
}

func TestSelectBaselineLatency(t *testing.T) {
	if got := selectBaselineLatency(true, []int{1, 2, 900}, []int{1, 2}, []int{900, 950}); got != 950 {
		t.Fatalf("tls-primary should prefer tls median, got %d", got)
	}
	if got := selectBaselineLatency(false, []int{3, 5, 7}, []int{3, 5, 7}, nil); got != 5 {
		t.Fatalf("tcp-primary should use overall median, got %d", got)
	}
}

func TestFetchProtocolPlanWithHostState(t *testing.T) {
	svc := &TargetService{}
	host := "app.mitce.net"

	plan := svc.fetchProtocolPlan(host, fetchHTTPModeAuto)
	if len(plan) != 2 || plan[0] != fetchHTTPModeH2 {
		t.Fatalf("default plan = %v, want h2 first", plan)
	}

	svc.markFetchProtocolSuccess(host, fetchHTTPModeH1)
	plan = svc.fetchProtocolPlan(host, fetchHTTPModeAuto)
	if len(plan) != 2 || plan[0] != fetchHTTPModeH1 {
		t.Fatalf("preferred h1 plan = %v, want h1 first", plan)
	}

	svc.markFetchProtocolFailure(host, fetchHTTPModeH1, errors.New("context deadline exceeded"))
	plan = svc.fetchProtocolPlan(host, fetchHTTPModeAuto)
	if len(plan) != 2 || plan[0] != fetchHTTPModeH2 {
		t.Fatalf("h1 penalized plan = %v, want h2 first", plan)
	}

	svc.fetchProtocolMu.Lock()
	st := svc.fetchProtocolState[host]
	st.AvoidH1To = time.Now().Add(-time.Second)
	svc.fetchProtocolState[host] = st
	svc.fetchProtocolMu.Unlock()

	plan = svc.fetchProtocolPlan(host, fetchHTTPModeAuto)
	if len(plan) != 2 || plan[0] != fetchHTTPModeH1 {
		t.Fatalf("expired penalty plan = %v, want preferred h1 first", plan)
	}
}
