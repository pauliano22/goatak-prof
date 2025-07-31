package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/go-resty/resty/v2"
	"github.com/kdudkov/goatak/pkg/model"
)

const (
	renewContacts = time.Second * 120
	httpTimeout   = time.Second * 5
)

type RemoteAPI struct {
	host   string
	client *resty.Client
	logger *slog.Logger
}

func NewRemoteAPI(host string, logger *slog.Logger) *RemoteAPI {
	client := resty.New()
	client.SetTimeout(30 * time.Second)
	client.SetRetryCount(3)
	client.SetRetryWaitTime(1 * time.Second)

	return &RemoteAPI{
		host:   host,
		client: client,
		logger: logger,
	}
}

func (api *RemoteAPI) SetTLS(config *tls.Config) {
	api.client.SetTLSClientConfig(config)
}

func (api *RemoteAPI) getURL(path string) string {
	if api.host == "" {
		return ""
	}

	// Handle different URL schemes
	baseURL := api.host
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		// Add port 8080 if host doesn't contain a port
		if !strings.Contains(baseURL, ":") {
			baseURL = baseURL + ":8080"
		}
		baseURL = "http://" + baseURL
	}

	// Ensure path starts with /
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	return baseURL + path
}

func (api *RemoteAPI) request(path string) *resty.Request {
	url := api.getURL(path)
	api.logger.Debug("Making request", "url", url, "path", path)
	return api.client.R().SetHeader("Content-Type", "application/json")
}

func (api *RemoteAPI) getContacts(ctx context.Context) ([]*model.Contact, error) {
	dat := make([]*model.Contact, 0)

	resp, err := api.request("/Marti/api/contacts/all").SetContext(ctx).Get(api.getURL("/Marti/api/contacts/all"))
	if err != nil {
		return nil, err
	}

	err = json.Unmarshal(resp.Body(), &dat)
	if err != nil {
		return nil, err
	}

	return dat, err
}

func (api *RemoteAPI) getConfig(ctx context.Context, uid string) {
	resp, err := api.request("/api/config").
		SetQueryParam("uid", uid).
		SetContext(ctx).
		Get(api.getURL("/api/config"))

	if err != nil {
		api.logger.Warn("Failed to get config", "error", err)
		return
	}

	api.logger.Info("Config retrieved", "status", resp.StatusCode())
}

func (app *App) periodicGetter(ctx context.Context) {
	ticker := time.NewTicker(renewContacts)
	defer ticker.Stop()

	d, _ := app.remoteAPI.getContacts(ctx)
	for _, c := range d {
		app.logger.Debug(fmt.Sprintf("contact %s %s", c.UID, c.Callsign))
		app.chatMessages.Contacts.Store(c.UID, c)
	}

	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			dat, err := app.remoteAPI.getContacts(ctx)
			if err != nil {
				app.logger.Warn("error getting contacts", slog.Any("error", err))

				continue
			}

			for _, c := range dat {
				app.logger.Debug(fmt.Sprintf("contact %s %s", c.UID, c.Callsign))
				app.chatMessages.Contacts.Store(c.UID, c)
			}
		}
	}
}
