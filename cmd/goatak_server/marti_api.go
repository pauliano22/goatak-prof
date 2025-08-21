package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/kdudkov/goatak/cmd/goatak_server/mp"
	"github.com/kdudkov/goatak/internal/pm"
	"github.com/kdudkov/goatak/pkg/cot"
	"github.com/kdudkov/goatak/pkg/log"
	"github.com/kdudkov/goatak/pkg/model"
	"github.com/kdudkov/goatak/pkg/util"

	"github.com/kdudkov/goatak/pkg/cotproto"
)

const (
	nodeID     = "main"
	apiVersion = "3"
)

type MartiAPI struct {
	f        *fiber.App
	addr     string
	tls      bool
	cert     tls.Certificate
	certPool *x509.CertPool
}

func (h *HttpServer) NewMartiAPI(app *App, addr string) *MartiAPI {
	api := &MartiAPI{
		f: fiber.New(fiber.Config{
			EnablePrintRoutes:     false,
			DisableStartupMessage: true,
			BodyLimit:             64 * 1024 * 1024,
			StreamRequestBody:     true}),
		addr: addr,
	}

	h.listeners["marti api calls"] = api

	api.f.Use(NewMetricHandler("marti_api"))
	api.f.Use(log.NewFiberLogger(&log.LoggerConfig{Name: "marti_api", UserGetter: Username}))

	if app.config.MartiSSL() {
		api.tls = true
		api.cert = *app.config.TlsCert
		api.certPool = app.config.CertPool
		api.f.Use(SSLCheckHandler(app))
	}

	addMartiRoutes(app, api.f)

	return api
}

func (api *MartiAPI) Address() string {
	return api.addr
}

func (api *MartiAPI) Listen() error {
	if api.tls {
		return api.f.ListenMutualTLSWithCertificate(api.addr, api.cert, api.certPool)
	} else {
		return api.f.Listen(api.addr)
	}
}

func addMartiRoutes(app *App, f fiber.Router) {
	f.Get("/Marti/api/version", getVersionHandler(app))
	f.Get("/Marti/api/version/config", getVersionConfigHandler(app))
	f.Get("/Marti/api/clientEndPoints", getEndpointsHandler(app))
	f.Get("/Marti/api/contacts/all", getContactsHandler(app))

	f.Get("/Marti/api/util/user/roles", getUserRolesHandler(app))

	f.Get("/Marti/api/groups/all", getAllGroupsHandler(app))
	f.Get("/Marti/api/groups/groupCacheEnabled", getAllGroupsCacheHandler(app))

	f.Get("/Marti/api/cops/hierarchy", getCopHierarchyHandler(app))

	f.Get("/Marti/api/device/profile/connection", getProfileConnectionHandler(app))
	f.Get("/Marti/api/device/profile/tool/:name", getProfileToolHandler(app))

	f.Get("/Marti/sync/search", getSearchHandler(app))
	f.Get("/Marti/sync/missionquery", getMissionQueryHandler(app))
	f.Post("/Marti/sync/missionupload", getMissionUploadHandler(app))
	f.Get("/Marti/sync/content", getContentGetHandler(app))
	f.Post("/Marti/sync/upload", getUploadHandler(app))
	f.Get("/Marti/api/cot/xml/:uid", getXmlHandler(app))
	f.Get("/Marti/api/sync/metadata/:hash/:name", getMetadataGetHandler(app))
	f.Put("/Marti/api/sync/metadata/:hash/:name", getMetadataPutHandler(app))

	f.Get("/Marti/vcm", getVideoListHandler(app))
	f.Post("/Marti/vcm", getVideoPostHandler(app))

	f.Get("/Marti/api/video", getVideo2ListHandler(app))

	addMissionApi(app, f)
}

func getVersionHandler(app *App) fiber.Handler {
	version := "GoATAK server " + getVersion()

	return func(ctx *fiber.Ctx) error {
		return ctx.SendString(version)
	}
}

func getVersionConfigHandler(_ *App) fiber.Handler {
	data := make(map[string]any)
	data["api"] = apiVersion
	data["version"] = getVersion()
	data["hostname"] = "0.0.0.0"

	return func(ctx *fiber.Ctx) error {
		return ctx.JSON(makeAnswer("ServerConfig", data))
	}
}

func getEndpointsHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		username := Username(ctx)
		user := app.users.Get(username)
		// secAgo := getIntParam(req, "secAgo", 0)
		data := make([]map[string]any, 0)

		app.items.ForEach(func(item *model.Item) bool {
			if user.CanSeeScope(item.GetScope()) && item.GetClass() == model.CONTACT {
				info := make(map[string]any)
				info["uid"] = item.GetUID()
				info["callsign"] = item.GetCallsign()
				info["lastEventTime"] = model.CotTime(item.GetLastSeen())

				if item.IsOnline() {
					info["lastStatus"] = "Connected"
				} else {
					info["lastStatus"] = "Disconnected"
				}

				data = append(data, info)
			}

			return true
		})

		return ctx.JSON(makeAnswer("com.bbn.marti.remote.ClientEndpoint", data))
	}
}

func getContactsHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		user := app.users.Get(Username(ctx))
		result := make([]*model.Contact, 0)

		app.items.ForEach(func(item *model.Item) bool {
			if user.CanSeeScope(item.GetScope()) && item.GetClass() == model.CONTACT {
				c := &model.Contact{
					UID:      item.GetUID(),
					Callsign: item.GetCallsign(),
					Team:     item.GetMsg().GetTeam(),
					Role:     item.GetMsg().GetRole(),
				}
				result = append(result, c)
			}

			return true
		})

		return ctx.JSON(result)
	}
}

func getMissionQueryHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		username := Username(ctx)
		user := app.users.Get(username)

		hash := ctx.Query("hash")
		if hash == "" {
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no hash")
		}

		c := app.dbm.ResourceQuery().Hash(hash).Scope(user.GetScope()).ReadScope(user.GetReadScope()).One()
		if c == nil {
			return ctx.SendStatus(fiber.StatusNotFound)
		}

		return ctx.SendString(resourceUrl(ctx.BaseURL(), c))
	}
}

func getMissionUploadHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		hash := ctx.Query("hash")
		fname := ctx.Query("filename")

		if hash == "" {
			app.logger.Error("no hash: ")
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no hash" + ctx.Request().URI().QueryArgs().String())
		}

		if fname == "" {
			app.logger.Error("no filename: " + ctx.Request().URI().QueryArgs().String())
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no filename")
		}

		c, err := app.uploadMultipart(ctx, "", hash, fname, true)
		if err != nil {
			app.logger.Error("error", slog.Any("error", err))
			return ctx.SendStatus(fiber.StatusNotAcceptable)
		}

		app.logger.Info(fmt.Sprintf("save packege %s %s %s", c.FileName, c.UID, c.Hash))

		return ctx.SendString(resourceUrl(ctx.BaseURL(), c))
	}
}

func getUploadHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		uid := ctx.Query("uid")
		fname := ctx.Query("name")

		if fname == "" {
			app.logger.Error("no name: " + ctx.Request().URI().QueryArgs().String())
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no name")
		}

		// DEBUG: Log the content type we're receiving
		contentType := ctx.Get(fiber.HeaderContentType)
		app.logger.Info("upload request",
			slog.String("filename", fname),
			slog.String("content-type", contentType),
			slog.String("method", ctx.Method()))

		switch {
		case strings.HasPrefix(contentType, "multipart/form-data"):
			app.logger.Info("processing as multipart")
			c, err := app.uploadMultipart(ctx, uid, "", fname, false)
			if err != nil {
				app.logger.Error("multipart upload error", slog.Any("error", err))
				return ctx.SendStatus(fiber.StatusNotAcceptable)
			}
			return ctx.SendString(resourceUrl(ctx.BaseURL(), c))

		default:
			app.logger.Info("processing as raw file", slog.String("content-type", contentType))
			c, err := app.uploadFile(ctx, uid, fname)
			if err != nil {
				app.logger.Error("raw upload error", slog.Any("error", err))
				return ctx.SendStatus(fiber.StatusNotAcceptable)
			}
			return ctx.SendString(resourceUrl(ctx.BaseURL(), c))
		}
	}
}

func (app *App) uploadMultipart(ctx *fiber.Ctx, uid, hash, filename string, pack bool) (*model.Resource, error) {
	username := Username(ctx)
	user := app.users.Get(username)

	// ✅ FIX: Extract keywords from form data
	keywords := ctx.FormValue("keywords")

	// Add debug logging
	app.logger.Info("upload debug",
		slog.String("filename", filename),
		slog.String("keywords_received", keywords),
		slog.String("content_type", ctx.Get(fiber.HeaderContentType)))

	fh, err := ctx.FormFile("assetfile")
	if err != nil {
		app.logger.Error("error getting form file", slog.Any("error", err))
		return nil, err
	}

	// Check if this is a video file that should go to data/videos
	isVideoForTools := strings.Contains(filename, "webcam-recording")

	if isVideoForTools {
		app.logger.Info("processing video for data/videos", slog.String("filename", filename))

		// Save to data/videos directory - consistent with other server data
		videosDir := filepath.Join(app.config.DataDir(), "videos")
		if err := os.MkdirAll(videosDir, 0755); err != nil {
			app.logger.Error("failed to create videos directory", slog.Any("error", err))
			return nil, err
		}

		// Clean filename (remove any path separators)
		cleanFilename := filepath.Base(filename)
		videoPath := filepath.Join(videosDir, cleanFilename)

		// Open the uploaded file
		f, err := fh.Open()
		if err != nil {
			app.logger.Error("failed to open uploaded file", slog.Any("error", err))
			return nil, err
		}
		defer f.Close()

		// Create the destination file in data/videos
		outFile, err := os.Create(videoPath)
		if err != nil {
			app.logger.Error("failed to create video file", slog.Any("error", err))
			return nil, err
		}
		defer outFile.Close()

		// Copy the uploaded file to data/videos
		copied, err := io.Copy(outFile, f)
		if err != nil {
			app.logger.Error("failed to copy video file", slog.Any("error", err))
			return nil, err
		}

		app.logger.Info("video saved to data/videos",
			slog.String("filename", cleanFilename),
			slog.String("path", videoPath),
			slog.Int64("bytes", copied))

		// ✅ FIX: Include repository keywords for videos
		videoKeywords := "video,webcam-recording"
		if keywords != "" {
			videoKeywords = keywords + "," + videoKeywords
		}

		// Create a simple resource record
		c := &model.Resource{
			Scope:          user.GetScope(),
			Hash:           "video-" + cleanFilename,
			UID:            uid,
			Name:           filename,
			FileName:       cleanFilename,
			MIMEType:       "video/webm",
			Size:           int(fh.Size),
			SubmissionUser: user.GetLogin(),
			CreatorUID:     queryIgnoreCase(ctx, "creatorUid"),
			Tool:           "webcam-recorder",
			Keywords:       videoKeywords, // ✅ FIX: Include all keywords
			Expiration:     -1,
		}

		// ✅ FIX: Populate KwSet from Keywords string
		c.KwSet = util.NewStringSet()
		for _, kw := range strings.Split(videoKeywords, ",") {
			if trimmed := strings.TrimSpace(kw); trimmed != "" {
				c.KwSet.Add(trimmed)
			}
		}

		err = app.dbm.Create(c)
		return c, err
	}

	// Regular file upload logic
	f, err := fh.Open()
	if err != nil {
		app.logger.Error("error opening file", slog.Any("error", err))
		return nil, err
	}
	defer f.Close()

	hash1, _, err := app.files.PutFile(user.GetScope(), hash, f)
	if err != nil {
		app.logger.Error("save file error", slog.Any("error", err))
		return nil, err
	}

	if hash != "" && hash != hash1 {
		app.logger.Error("bad hash")
		return nil, err
	}

	c := &model.Resource{
		Scope:          user.GetScope(),
		Hash:           hash1,
		UID:            uid,
		Name:           filename,
		FileName:       fh.Filename,
		MIMEType:       fh.Header.Get(fiber.HeaderContentType),
		Size:           int(fh.Size),
		SubmissionUser: user.GetLogin(),
		CreatorUID:     queryIgnoreCase(ctx, "creatorUid"),
		Tool:           "",
		Keywords:       keywords, // ✅ FIX: Use extracted keywords
		Expiration:     -1,
	}

	// ✅ FIX: Populate KwSet from Keywords string
	c.KwSet = util.NewStringSet()
	if keywords != "" {
		for _, kw := range strings.Split(keywords, ",") {
			if trimmed := strings.TrimSpace(kw); trimmed != "" {
				c.KwSet.Add(trimmed)
			}
		}
	}

	if pack {
		c.KwSet.Add("missionpackage")
		c.Tool = "public"
	}

	err = app.dbm.Create(c)
	return c, err
}

func (app *App) uploadFile(ctx *fiber.Ctx, uid, filename string) (*model.Resource, error) {
	username := Username(ctx)
	user := app.users.Get(username)

	// ✅ FIX: Extract keywords from form data
	keywords := ctx.FormValue("keywords")

	// Add debug logging
	app.logger.Info("raw upload debug",
		slog.String("filename", filename),
		slog.String("keywords_received", keywords))

	hash, n, err := app.files.PutFile(user.GetScope(), "", ctx.Context().RequestBodyStream())
	if err != nil {
		app.logger.Error("save file error", slog.Any("error", err))
		return nil, err
	}

	c := &model.Resource{
		Scope:          user.GetScope(),
		Hash:           hash,
		UID:            uid,
		Name:           filename,
		FileName:       filename,
		MIMEType:       ctx.Get(fiber.HeaderContentType),
		Size:           int(n),
		SubmissionUser: user.GetLogin(),
		CreatorUID:     queryIgnoreCase(ctx, "creatorUid"),
		Tool:           "",
		Keywords:       keywords, // ✅ FIX: Use extracted keywords
		Expiration:     -1,
	}

	// ✅ FIX: Populate KwSet from Keywords string
	c.KwSet = util.NewStringSet()
	if keywords != "" {
		for _, kw := range strings.Split(keywords, ",") {
			if trimmed := strings.TrimSpace(kw); trimmed != "" {
				c.KwSet.Add(trimmed)
			}
		}
	}

	err = app.dbm.Create(c)
	return c, err
}

func getContentGetHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		username := Username(ctx)
		user := app.users.Get(username)

		hash := ctx.Query("hash")
		uid := ctx.Query("uid")

		if hash == "" && uid == "" {
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no hash or uid")
		}

		fi := app.dbm.ResourceQuery().Scope(user.GetScope()).ReadScope(user.GetReadScope()).Hash(hash).UID(uid).One()

		if fi == nil {
			return ctx.Status(fiber.StatusNotFound).SendString("not found")
		}

		f, err := app.files.GetFile(hash, fi.Scope)

		if err != nil {
			if errors.Is(err, pm.ErrNotFound) {
				app.logger.Info("not found - hash " + hash)

				return ctx.Status(fiber.StatusNotFound).SendString("not found")
			}
			app.logger.Error("get file error", slog.Any("error", err))

			return err
		}

		defer f.Close()

		ctx.Set(fiber.HeaderContentType, fi.MIMEType)
		ctx.Set(fiber.HeaderLastModified, fi.CreatedAt.UTC().Format(http.TimeFormat))
		ctx.Set(fiber.HeaderContentLength, strconv.Itoa(fi.Size))
		ctx.Set("ETag", fi.Hash)

		_, err = io.Copy(ctx.Response().BodyWriter(), f)

		return err
	}
}

func getMetadataGetHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		hash := ctx.Params("hash")
		name := ctx.Params("name")
		username := Username(ctx)
		user := app.users.Get(username)

		if hash == "" {
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no hash")
		}

		cn := app.dbm.ResourceQuery().Scope(user.GetScope()).ReadScope(user.GetReadScope()).Hash(hash).One()

		if cn == nil {
			return ctx.SendStatus(fiber.StatusNotFound)
		}

		switch name {
		case "tool":
			return ctx.SendString(cn.Tool)
		default:
			return ctx.SendString("")
		}
	}
}

func getMetadataPutHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		user := app.users.Get(Username(ctx))
		hash := ctx.Params("hash")
		name := ctx.Params("name")

		if hash == "" {
			return ctx.Status(fiber.StatusNotAcceptable).SendString("no hash")
		}

		cn := app.dbm.ResourceQuery().Scope(user.GetScope()).ReadScope(user.GetReadScope()).Hash(hash).One()

		if cn == nil {
			return ctx.SendStatus(fiber.StatusNotFound)
		}

		val := string(ctx.Body())

		_ = app.dbm.MissionQuery().Id(cn.ID).Update(map[string]any{name: val})

		return nil
	}
}

func getSearchHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		user := app.users.Get(Username(ctx))
		kw := ctx.Query("keywords")

		files := app.dbm.ResourceQuery().Scope(user.GetScope()).ReadScope(user.GetReadScope()).
			Tool(ctx.Query("tool")).Get()
		res := make([]*model.ResourceDTO, 0, len(files))

		for _, f := range files {
			// ✅ FIX: Only filter by keywords if a keyword is specified
			if kw != "" && !f.KwSet.Has(kw) {
				continue
			}

			if f.Scope != user.Scope {
				f.Name += fmt.Sprintf(" [%s]", f.Scope)
			}

			res = append(res, model.ToResourceDTO(f))
		}

		app.logger.Info(fmt.Sprintf("found %d dp", len(res)))
		return ctx.JSON(fiber.Map{"resultCount": len(res), "results": res})
	}
}

func getUserRolesHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		return ctx.JSON([]string{"user", "webuser"})
	}
}

func getAllGroupsHandler(app *App) fiber.Handler {
	g := make(map[string]any)
	g["name"] = "__ANON__"
	g["direction"] = "OUT"
	g["created"] = "2023-01-01"
	g["type"] = "SYSTEM"
	g["bitpos"] = 2
	g["active"] = true

	result := makeAnswer("com.bbn.marti.remote.groups.Group", []map[string]any{g})

	return func(ctx *fiber.Ctx) error {
		return ctx.JSON(result)
	}
}

func getAllGroupsCacheHandler(_ *App) fiber.Handler {
	result := makeAnswer("java.lang.Boolean", true)

	return func(ctx *fiber.Ctx) error {
		return ctx.JSON(result)
	}
}

func getCopHierarchyHandler(_ *App) fiber.Handler {
	result := makeAnswer("CopHierarchyNode", []string{})

	return func(ctx *fiber.Ctx) error {
		return ctx.JSON(result)
	}
}

func getProfileConnectionHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		username := Username(ctx)
		uid := queryIgnoreCase(ctx, "clientUid")

		if !app.checkUID(uid) {
			return ctx.SendStatus(fiber.StatusForbidden)
		}

		files := app.GetProfileFiles(username, uid, false)

		if len(files) == 0 {
			return ctx.SendStatus(fiber.StatusNoContent)
		}

		app.logger.Info(fmt.Sprintf("prepare connection dp for uid %s, %d files", uid, len(files)))

		//missionPackage := mp.NewMissionPackage(uuid.NewString(), "Connection")
		missionPackage := mp.NewMissionPackage(uuid.NewSHA1(uuid.Nil, []byte(uid)).String(), "Connection")
		missionPackage.Param("onReceiveImport", "true")
		missionPackage.Param("onReceiveDelete", "true")
		missionPackage.AddFiles(files...)
		dat, err := missionPackage.Create()

		if err != nil {
			return err
		}

		ctx.Set(fiber.HeaderContentType, "application/zip")
		ctx.Set(fiber.HeaderContentDisposition, "attachment; filename=profile.zip")

		return ctx.Send(dat)
	}
}

func getProfileToolHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		//username := Username(ctx)
		uid := queryIgnoreCase(ctx, "clientUid")
		//name := ctx.Params("name")

		if !app.checkUID(uid) {
			return ctx.SendStatus(fiber.StatusForbidden)
		}

		return ctx.SendStatus(fiber.StatusNoContent)
	}
}

func getVideoListHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		r := new(model.VideoConnections)
		user := app.users.Get(Username(ctx))

		for _, f := range app.dbm.FeedQuery().Scope(user.Scope).ReadScope(user.ReadScope).Get() {
			r.Feeds = append(r.Feeds, f.DTOOld())
		}

		return ctx.XML(r)
	}
}

func getVideo2ListHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		user := app.users.Get(Username(ctx))

		feeds := app.dbm.FeedQuery().Scope(user.Scope).ReadScope(user.ReadScope).Get()
		conn := make([]*model.VideoConnections2, len(feeds))

		for i, f := range feeds {
			conn[i] = &model.VideoConnections2{Feeds: []*model.Feed2DTO{f.DTO(false)}}
		}

		return ctx.JSON(fiber.Map{"videoConnections": conn})
	}
}

func getVideoPostHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		username := Username(ctx)
		user := app.users.Get(username)

		r := new(model.VideoConnections)

		if err := ctx.BodyParser(r); err != nil {
			return err
		}

		for _, f := range r.Feeds {
			f2 := f.ToFeed2()
			f2.Active = true
			f2.User = username
			f2.Scope = user.GetScope()

			if err := app.dbm.Save(f2); err != nil {
				app.logger.Error("error save feed", slog.Any("error", err))
			}
		}

		return nil
	}
}

func getXmlHandler(app *App) fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		uid := ctx.Params("uid")

		if uid == "" {
			return ctx.SendStatus(fiber.StatusBadRequest)
		}

		var evt *cotproto.CotEvent
		if item := app.items.Get(uid); item != nil {
			evt = item.GetMsg().GetTakMessage().GetCotEvent()
		} else {
			di := app.dbm.PointQuery().UID(uid).One()
			if di != nil {
				evt = di.GetEvent()
			}
		}

		if evt == nil {
			return ctx.SendStatus(fiber.StatusNotFound)
		}

		return ctx.XML(cot.CotToEvent(evt))
	}
}

func resourceUrl(root string, c *model.Resource) string {
	return fmt.Sprintf("%s/Marti/sync/content?hash=%s", root, c.Hash)
}

func makeAnswer(typ string, data any) map[string]any {
	result := make(map[string]any)
	result["version"] = apiVersion
	result["type"] = typ
	result["nodeId"] = nodeID
	result["data"] = data

	return result
}
