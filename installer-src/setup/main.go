//go:build windows

// Glazed setup helper, run by Glazed-Setup.msi as an elevated custom action.
//   glazed-setup install   --dir <install dir> --user <profile dir> [--msi <path of the .msi>]
//   glazed-setup uninstall --dir <install dir> --user <profile dir>
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed app.zip
var appZip []byte

//go:embed launcher.exe
var launcherExe []byte

//go:embed icons/*.png
var iconFS embed.FS

const (
	electronVersion = "33.2.0"
	electronSHA256  = "9f2cb12d87761a5e0bbd69960507172223132cbbfc32737dc4ed9803ae971288"
)

var logFile *os.File

func logf(format string, a ...any) {
	line := time.Now().Format("15:04:05 ") + fmt.Sprintf(format, a...) + "\n"
	if logFile != nil {
		logFile.WriteString(line)
	}
}

func fail(err error) {
	logf("FAILED: %v", err)
	os.Exit(1)
}

func hidden(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return c
}

func unzipTo(data []byte, dest string, skip func(string) bool) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	root := filepath.Clean(dest)
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if skip != nil && skip(name) {
			continue
		}
		target := filepath.Join(root, filepath.FromSlash(name))
		if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
			continue // zip-slip protection
		}
		if f.FileInfo().IsDir() || strings.HasSuffix(name, "/") {
			os.MkdirAll(target, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func runtimeZip(msiPath string) ([]byte, error) {
	name := "electron-v" + electronVersion + "-win32-x64.zip"
	// offline install: a copy of the runtime next to the .msi is used if present
	if msiPath != "" {
		local := filepath.Join(filepath.Dir(msiPath), name)
		if b, err := os.ReadFile(local); err == nil && checksumOK(b) {
			logf("using local runtime %s", local)
			return b, nil
		}
	}
	url := "https://github.com/electron/electron/releases/download/v" + electronVersion + "/" + name
	var last error
	for attempt := 1; attempt <= 3; attempt++ {
		logf("downloading %s (attempt %d)", url, attempt)
		client := &http.Client{Timeout: 15 * time.Minute}
		resp, err := client.Get(url)
		if err == nil {
			if resp.StatusCode == 200 {
				b, rerr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if rerr == nil && checksumOK(b) {
					return b, nil
				}
				last = fmt.Errorf("download corrupted (read error %v)", rerr)
			} else {
				resp.Body.Close()
				last = fmt.Errorf("HTTP %d", resp.StatusCode)
			}
		} else {
			last = err
		}
		logf("download problem: %v", last)
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	return nil, fmt.Errorf("could not download the Chromium runtime: %v", last)
}

func checksumOK(b []byte) bool {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]) == electronSHA256
}

func startMenuDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Microsoft", "Windows", "Start Menu", "Programs")
}

func downloadsDir(user string) string {
	if user == "" || strings.Contains(strings.ToLower(user), "systemprofile") {
		return ""
	}
	return filepath.Join(user, "Downloads")
}

func install(dir, user, msiPath string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	exe := filepath.Join(dir, "Glazed.exe")
	if _, err := os.Stat(exe); err != nil {
		z, err := runtimeZip(msiPath)
		if err != nil {
			return err
		}
		logf("extracting runtime")
		if err := unzipTo(z, dir, nil); err != nil {
			return err
		}
		if err := os.Rename(filepath.Join(dir, "electron.exe"), exe); err != nil {
			return err
		}
		os.Remove(filepath.Join(dir, "resources", "default_app.asar"))
		pngs := map[int][]byte{}
		for _, n := range []int{16, 32, 48, 256} {
			b, _ := iconFS.ReadFile(fmt.Sprintf("icons/%d.png", n))
			pngs[n] = b
		}
		if err := patchIcons(exe, pngs); err != nil {
			logf("icon patch failed (non-fatal): %v", err)
		}
	}
	logf("writing app files")
	appDir := filepath.Join(dir, "resources", "app")
	os.RemoveAll(appDir)
	if err := unzipTo(appZip, appDir, nil); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(appDir, "main.js")); err != nil {
		return fmt.Errorf("app files missing after copy")
	}
	// start menu shortcut
	lnk := filepath.Join(startMenuDir(), "Glazed.lnk")
	ps := fmt.Sprintf(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s,0';$s.Save()`,
		strings.ReplaceAll(lnk, "'", "''"), strings.ReplaceAll(exe, "'", "''"), strings.ReplaceAll(dir, "'", "''"), strings.ReplaceAll(exe, "'", "''"))
	if out, err := hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps).CombinedOutput(); err != nil {
		logf("start menu shortcut failed (non-fatal): %v %s", err, out)
	}
	registerBrowser(exe)
	// launcher .exe in the user's Downloads folder
	if dl := downloadsDir(user); dl != "" {
		if err := os.MkdirAll(dl, 0o755); err == nil {
			if err := os.WriteFile(filepath.Join(dl, "Glazed.exe"), launcherExe, 0o755); err != nil {
				logf("could not write launcher to Downloads (non-fatal): %v", err)
			} else {
				logf("launcher written to %s", dl)
			}
		}
	} else {
		logf("no user profile known; launcher not written")
	}
	return nil
}

const clientKey = `HKLM\SOFTWARE\Clients\StartMenuInternet\Glazed`

func regAdd(key, name, value string, dword bool) {
	args := []string{"add", key, "/f"}
	if name == "" {
		args = append(args, "/ve")
	} else {
		args = append(args, "/v", name)
	}
	if dword {
		args = append(args, "/t", "REG_DWORD", "/d", value)
	} else {
		args = append(args, "/t", "REG_SZ", "/d", value)
	}
	if out, err := hidden("reg.exe", args...).CombinedOutput(); err != nil {
		logf("reg add %s failed (non-fatal): %v %s", key, err, out)
	}
}

// registerBrowser makes Glazed appear in Windows "Default apps" (web browser, .html files, http/https links).
func registerBrowser(exe string) {
	cmd := `"` + exe + `" "%1"`
	regAdd(clientKey, "", "Glazed", false)
	regAdd(clientKey+`\Capabilities`, "ApplicationName", "Glazed", false)
	regAdd(clientKey+`\Capabilities`, "ApplicationDescription", "Glazed - a quiet, customizable browser", false)
	regAdd(clientKey+`\Capabilities`, "ApplicationIcon", exe+",0", false)
	regAdd(clientKey+`\Capabilities\URLAssociations`, "http", "GlazedURL", false)
	regAdd(clientKey+`\Capabilities\URLAssociations`, "https", "GlazedURL", false)
	for _, ext := range []string{".htm", ".html", ".xhtml", ".svg", ".pdf"} {
		regAdd(clientKey+`\Capabilities\FileAssociations`, ext, "GlazedHTML", false)
	}
	regAdd(clientKey+`\Capabilities\StartMenu`, "StartMenuInternet", "Glazed", false)
	regAdd(clientKey+`\DefaultIcon`, "", exe+",0", false)
	regAdd(clientKey+`\InstallInfo`, "IconsVisible", "1", true)
	regAdd(clientKey+`\shell\open\command`, "", `"`+exe+`"`, false)
	regAdd(`HKLM\SOFTWARE\RegisteredApplications`, "Glazed", `SOFTWARE\Clients\StartMenuInternet\Glazed\Capabilities`, false)
	for _, c := range []struct{ id, name string }{{"GlazedURL", "Glazed URL"}, {"GlazedHTML", "Glazed HTML Document"}} {
		k := `HKLM\SOFTWARE\Classes\` + c.id
		regAdd(k, "", c.name, false)
		if c.id == "GlazedURL" {
			regAdd(k, "URL Protocol", "", false)
		}
		regAdd(k+`\DefaultIcon`, "", exe+",0", false)
		regAdd(k+`\shell\open\command`, "", cmd, false)
	}
}

func unregisterBrowser() {
	for _, k := range []string{clientKey, `HKLM\SOFTWARE\Classes\GlazedURL`, `HKLM\SOFTWARE\Classes\GlazedHTML`} {
		hidden("reg.exe", "delete", k, "/f").Run()
	}
	hidden("reg.exe", "delete", `HKLM\SOFTWARE\RegisteredApplications`, "/v", "Glazed", "/f").Run()
}

func uninstall(dir, user string) error {
	unregisterBrowser()
	hidden("taskkill.exe", "/F", "/IM", "Glazed.exe").Run()
	time.Sleep(1500 * time.Millisecond)
	os.Remove(filepath.Join(startMenuDir(), "Glazed.lnk"))
	if dl := downloadsDir(user); dl != "" {
		p := filepath.Join(dl, "Glazed.exe")
		if b, err := os.ReadFile(p); err == nil && bytes.Equal(b, launcherExe) {
			os.Remove(p)
		}
	}
	var err error
	for i := 0; i < 5; i++ {
		if err = os.RemoveAll(dir); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	return err
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	logPath := filepath.Join(os.TempDir(), "glazed-setup.log")
	logFile, _ = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	var dir, user, msiPath string
	for i := 2; i+1 < len(os.Args); i += 2 {
		switch os.Args[i] {
		case "--dir":
			dir = os.Args[i+1]
		case "--user":
			user = os.Args[i+1]
		case "--msi":
			msiPath = os.Args[i+1]
		}
	}
	dir = filepath.Clean(strings.TrimSpace(dir))
	logf("%s dir=%q user=%q msi=%q", os.Args[1], dir, user, msiPath)
	if dir == "." || len(dir) < 8 || !strings.EqualFold(filepath.Base(dir), "Glazed") {
		fail(fmt.Errorf("refusing unsafe install directory %q", dir))
	}
	switch os.Args[1] {
	case "install":
		if err := install(dir, user, msiPath); err != nil {
			fail(err)
		}
	case "uninstall":
		if err := uninstall(dir, user); err != nil {
			logf("uninstall problem (ignored): %v", err)
		}
	default:
		os.Exit(2)
	}
	logf("done")
}
