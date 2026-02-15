package geo

import (
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

type Resolver interface {
	Lookup(ip string) (string, error)
}

type IP2RegionResolver struct {
	searcher *xdb.Searcher
}

func NewIP2RegionResolver(dbPath string) (*IP2RegionResolver, error) {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		return nil, fmt.Errorf("ip region db path is empty")
	}

	raw, err := os.ReadFile(dbPath)
	if err != nil {
		return nil, fmt.Errorf("read ip region db failed: %w", err)
	}

	searcher, err := xdb.NewWithBuffer(xdb.IPvx, raw)
	if err != nil {
		return nil, fmt.Errorf("open ip region db failed: %w", err)
	}

	return &IP2RegionResolver{searcher: searcher}, nil
}

func (r *IP2RegionResolver) Lookup(ip string) (string, error) {
	ip = strings.TrimSpace(ip)
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return "", fmt.Errorf("invalid ip")
	}
	if parsed.IsLoopback() || parsed.IsPrivate() {
		return "内网IP", nil
	}

	raw, err := r.searcher.SearchByStr(parsed.String())
	if err != nil {
		return "", err
	}

	parts := strings.Split(raw, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "0" {
			continue
		}
		out = append(out, part)
	}

	if len(out) == 0 {
		return "未知", nil
	}

	return strings.Join(out, " "), nil
}
