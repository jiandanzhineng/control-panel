package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	config, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	app, err := newApp(config)
	if err != nil {
		log.Fatal(err)
	}
	defer app.close()
	if len(os.Args) > 1 && os.Args[1] == "rebuild-registry" {
		if err := app.rebuildRegistry(context.Background()); err != nil {
			log.Fatal(err)
		}
		log.Printf("registry rebuilt")
		return
	}
	server := &http.Server{
		Addr:              config.ListenAddr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      75 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Printf("game platform listening on %s with %s storage", config.ListenAddr, config.StorageDriver)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	signalChannel := make(chan os.Signal, 1)
	signal.Notify(signalChannel, os.Interrupt, syscall.SIGTERM)
	<-signalChannel
	context, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(context); err != nil {
		log.Printf("server shutdown failed: %v", err)
	}
}
