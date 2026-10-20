//go:build windows

// Glazed launcher: starts the installed browser from C:\Program Files\Glazed.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

func msg(text string) {
	u := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("Glazed")
	u.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}

func main() {
	roots := []string{os.Getenv("ProgramW6432"), os.Getenv("ProgramFiles"), `C:\Program Files`}
	for _, r := range roots {
		if r == "" {
			continue
		}
		exe := filepath.Join(r, "Glazed", "Glazed.exe")
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Dir = filepath.Dir(exe)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
		if err := cmd.Start(); err != nil {
			msg("Glazed could not be started:\n" + err.Error())
			os.Exit(1)
		}
		return
	}
	msg("Glazed is not installed (C:\\Program Files\\Glazed was not found).\nPlease run Glazed-Setup.msi again.")
	os.Exit(1)
}
