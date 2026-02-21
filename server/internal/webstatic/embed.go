package webstatic

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

func DistFS() (fs.FS, error) {
	return fs.Sub(embedded, "dist")
}

func HasIndex(dist fs.FS) bool {
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return false
	}
	return true
}
