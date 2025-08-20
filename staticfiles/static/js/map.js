var map = null;

const app = Vue.createApp({
    data: function () {
        return {
            layers: null,
            conn: null,
            status: "",
            unitsMap: Vue.shallowRef(new Map()),
            messages: [],
            seenMessages: new Set(),
            ts: 0,
            locked_unit_uid: '',
            current_unit_uid: null,
            config: null,
            tools: new Map(),
            me: null,
            coords: null,
            point_num: 1,
            coord_format: "d",
            form_unit: {},
            types: null,
            chatroom: "",
            chat_uid: "",
            chat_msg: "",
            multiSelectMode: false,
            selectedUnits: new Set(),
            // Camera streaming additions
            currentVideo: null,
            webcamStream: null,
            webrtcPeerConnection: null,
            hlsInstance: null,
            // Recording additions
            mediaRecorder: null,
            recordedChunks: [],
            isRecording: false,
            standaloneRecording: {
                isActive: false,
                stream: null,
                recorder: null,
                chunks: [],
                startTime: null
            },
            // File repository additions
            currentFileRepository: null,
            repositoryFiles: [],
            selectedFiles: null,
            uploadProgress: 0,
            isUploading: false,
        }
    },

    mounted() {
        map = L.map('map');
        map.setView([60, 30], 11);

        L.control.scale({ metric: true }).addTo(map);

        this.getConfig();

        let supportsWebSockets = 'WebSocket' in window || 'MozWebSocket' in window;

        if (supportsWebSockets) {
            this.connect();
        }

        this.renew();
        setInterval(this.renew, 5000);
        setInterval(this.sender, 1000);

        map.on('click', this.mapClick);
        map.on('mousemove', this.mouseMove);

        this.formFromUnit(null);

        // Cleanup webcam when page unloads
        window.addEventListener('beforeunload', () => {
            this.destroyWebcamStream();
        });
    },

    computed: {
        current_unit: function () {
            return this.current_unit_uid ? this.current_unit_uid && this.getCurrentUnit() : null;
        },
        units: function () {
            return this.unitsMap?.value || new Map();
        }
    },

    methods: {
        getConfig: function () {
            let vm = this;

            fetch('/api/config')
                .then(resp => resp.json())
                .then(data => {
                    vm.config = data;

                    map.setView([data.lat, data.lon], data.zoom);

                    if (vm.config.callsign) {
                        vm.me = L.marker([data.lat, data.lon]);
                        vm.me.setIcon(L.icon({
                            iconUrl: "/static/icons/self.png",
                            iconAnchor: new L.Point(16, 16),
                        }));
                        vm.me.addTo(map);

                        fetch('/api/types')
                            .then(resp => resp.json())
                            .then(d => vm.types = d);
                    }

                    layers = L.control.layers({}, null, { hideSingleBase: true });
                    layers.addTo(map);

                    let first = true;
                    data.layers.forEach(i => {
                        let opts = {
                            minZoom: i.min_zoom ?? 1,
                            maxZoom: i.max_zoom ?? 20,
                        }

                        if (i.server_parts) {
                            opts["subdomains"] = i.server_parts;
                        }

                        l = L.tileLayer(i.url, opts);

                        layers.addBaseLayer(l, i.name);

                        if (first) {
                            first = false;
                            l.addTo(map);
                        }
                    });
                });
        },

        connect: function () {
            let url = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
            let vm = this;

            this.fetchAllUnits();
            this.fetchMessages();

            this.conn = new WebSocket(url);

            this.conn.onmessage = function (e) {
                vm.processWS(JSON.parse(e.data));
            };

            this.conn.onopen = function (e) {
                console.log("connected");
                vm.status = "connected";
            };

            this.conn.onerror = function (e) {
                console.log("error");
                vm.status = "error";
            };

            this.conn.onclose = function (e) {
                console.log("closed");
                vm.status = "";
                setTimeout(vm.connect, 3000);
            };
        },

        fetchAllUnits: function () {
            let vm = this;

            fetch('/api/unit', { redirect: 'manual' })
                .then(resp => {
                    if (!resp.ok) {
                        window.location.reload();
                    }
                    return resp.json();
                })
                .then(vm.processUnits);
        },

        fetchMessages: function () {
            let vm = this;

            fetch('/api/message', { redirect: 'manual' })
                .then(resp => {
                    if (!resp.ok) {
                        window.location.reload();
                    }
                    return resp.json();
                })
                .then(d => vm.messages = d);
        },

        renew: function () {
            if (!this.conn) {
                this.fetchAllUnits();
                this.fetchMessages();
            }
        },

        sender: function () {
            if (this.getTool("dp1")) {
                let p = this.getTool("dp1").getLatLng();

                const requestOptions = {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ lat: p.lat, lon: p.lng, name: "DP1" })
                };
                fetch("/api/dp", requestOptions);
            }
        },

        processUnits: function (data) {
            let keys = new Set();

            for (let u of data) {
                keys.add(this.processUnit(u)?.uid);
            }

            for (const k of this.units.keys()) {
                if (!keys.has(k)) {
                    this.removeUnit(k);
                }
            }
        },

        // Updated processUnit function - extracts stream info for all clients
        processUnit: function (u) {
            if (!u) return;
            let unit = this.units.get(u.uid);

            if (!unit) {
                unit = new Unit(this, u);
                this.units.set(u.uid, unit);
            } else {
                unit.update(u)
            }

            // CRITICAL FIX: Extract stream info for camera points on ALL clients
            if (u.type === "b-m-p-s-p-v" && u.text) {
                try {
                    const streamInfo = JSON.parse(u.text);
                    if (streamInfo.streamUrl) {
                        // Reconstruct camera properties from transmitted data
                        u.isCamera = true;
                        u.streamUrl = streamInfo.streamUrl;
                        u.streamType = streamInfo.streamType || this.detectStreamType(streamInfo.streamUrl);
                        console.log('Camera stream info extracted:', {
                            callsign: u.callsign,
                            streamUrl: u.streamUrl,
                            streamType: u.streamType
                        });
                    }
                } catch (e) {
                    // Fallback: if text isn't JSON but type is camera, mark as camera
                    console.log('Camera point detected but no valid stream info:', u.callsign);
                    if (u.type === "b-m-p-s-p-v") {
                        u.isCamera = true;
                        // Could extract URL from plain text as fallback
                        const urlMatch = u.text.match(/(https?:\/\/[^\s]+|rtsp:\/\/[^\s]+)/);
                        if (urlMatch) {
                            u.streamUrl = urlMatch[0];
                            u.streamType = this.detectStreamType(u.streamUrl);
                        }
                    }
                }
            }

            // Also handle file repository points similarly
            if (u.type === "b-m-p-s-p-f" && u.text) {
                try {
                    const repoInfo = JSON.parse(u.text);
                    if (repoInfo.repositoryName) {
                        u.isFileRepository = true;
                        u.repositoryName = repoInfo.repositoryName;
                    }
                } catch (e) {
                    // Fallback for file repository
                    if (u.type === "b-m-p-s-p-f") {
                        u.isFileRepository = true;
                        u.repositoryName = u.callsign;
                    }
                }
            }

            if (this.locked_unit_uid === unit.uid) {
                map.setView(unit.coords());
            }

            this.ts++;
            return unit;
        },

        processWS: function (u) {
            if (u.type === "unit") {
                this.processUnit(u.unit);
            }

            if (u.type === "delete") {
                this.removeUnit(u.uid);
            }

            if (u.type === "chat") {
                this.fetchMessages();
            }
        },

        removeUnit: function (uid) {
            if (!this.units.has(uid)) return;

            let item = this.units.get(uid);
            item.removeMarker()
            this.units.delete(uid);

            if (this.current_unit_uid === uid) {
                this.setCurrentUnitUid(null, false);
            }
        },

        setCurrentUnitUid: function (uid, follow) {
            if (uid && this.units.has(uid)) {
                this.current_unit_uid = uid;
                let u = this.units.get(uid);
                if (follow) this.mapToUnit(u);
                this.formFromUnit(u);
            } else {
                this.current_unit_uid = null;
                this.formFromUnit(null);
            }
        },

        getCurrentUnit: function () {
            if (!this.current_unit_uid || !this.units.has(this.current_unit_uid)) return null;
            return this.units.get(this.current_unit_uid);
        },

        byCategory: function (s) {
            let arr = Array.from(this.units.values()).filter(function (u) {
                return u.unit.category === s
            });
            arr.sort(function (a, b) {
                return a.compare(b);
            });
            return this.ts && arr;
        },

        mapToUnit: function (u) {
            if (u && u.hasCoords()) {
                map.setView(u.coords());
            }
        },

        getImg: function (item, size) {
            return getIconUri(item, size, false).uri;
        },

        milImg: function (item) {
            return getMilIconUri(item, 24, false).uri;
        },

        dt: function (str) {
            let d = new Date(Date.parse(str));
            return ("0" + d.getDate()).slice(-2) + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
                d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
        },

        sp: function (v) {
            return (v * 3.6).toFixed(1);
        },

        modeIs: function (s) {
            const element = document.getElementById(s);
            return element ? element.checked : false;
        },

        mouseMove: function (e) {
            this.coords = e.latlng;
        },

        mapClick: function (e) {
            let tool = document.querySelector('input[name="btnradio"]:checked').id;

            switch (tool) {
                case 'select':
                    // No action for select mode - just click to select units
                    break;

                case 'camera':
                    this.addCameraPoint(e.latlng);
                    break;

                case 'files':
                    this.addFileRepositoryPoint(e.latlng);
                    break;

                case 'record':
                    // Start standalone recording
                    this.startStandaloneRecording();
                    // Reset to select tool after starting recording
                    document.getElementById('select').checked = true;
                    break;

                case 'fire':
                    this.createSpecialPoint(e.latlng, "Fire", "b-r-f-h-c", "Fire Location", "#ff8c00");
                    break;

                case 'water':
                    this.createSpecialPoint(e.latlng, "Water", "b-m-p-w", "Water Source", "#0066cc");
                    break;

                case 'observation':
                    this.createSpecialPoint(e.latlng, "Observation", "b-m-p-s-p-op", "Observation Point", "#ffff00");
                    break;

                case 'hazard':
                    this.createSpecialPoint(e.latlng, "Hazard", "b-r-f-h-c", "Hazard", "#ff0000");
                    break;

                case 'redx':
                    this.addOrMove("redx", e.latlng, "/static/icons/x.png");
                    break;

                case 'dp1':
                    this.addOrMove("dp1", e.latlng, "/static/icons/spoi_icon.png");
                    break;

                case 'point':
                    let uid = uuidv4();
                    let now = new Date();
                    let stale = new Date(now);
                    stale.setDate(stale.getDate() + 365);

                    let u = {
                        uid: uid,
                        category: "point",
                        callsign: "point-" + this.point_num++,
                        sidc: "",
                        start_time: now,
                        last_seen: now,
                        stale_time: stale,
                        type: "b-m-p-s-m",
                        lat: e.latlng.lat,
                        lon: e.latlng.lng,
                        hae: 0,
                        speed: 0,
                        course: 0,
                        status: "",
                        text: "",
                        parent_uid: "",
                        parent_callsign: "",
                        color: "#ff0000",
                        send: false,
                        local: true,
                    }

                    if (this.config && this.config.uid) {
                        u.parent_uid = this.config.uid;
                        u.parent_callsign = this.config.callsign;
                    }

                    let unit = new Unit(this, u);
                    this.units.set(unit.uid, unit);
                    unit.post();

                    this.setCurrentUnitUid(u.uid, true);
                    break;

                case 'me':
                    this.config.lat = e.latlng.lat;
                    this.config.lon = e.latlng.lng;
                    this.me.setLatLng(e.latlng);

                    const requestOptions = {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ lat: e.latlng.lat, lon: e.latlng.lng })
                    };
                    fetch("/api/pos", requestOptions);
                    break;

                default:
                    console.log('Unknown tool selected:', tool);
                    break;
            }
        },

        // NEW CAMERA METHODS
        async addCameraPoint(latlng) {
            const streamUrl = prompt("Enter stream URL (RTSP, HLS, WebRTC, or regular video):", "rtsp://example.com/stream");
            if (!streamUrl) {
                return; // User cancelled
            }

            let uid = uuidv4();
            let now = new Date();
            let stale = new Date(now);
            stale.setDate(stale.getDate() + 365);

            // Detect stream type based on URL
            const streamType = this.detectStreamType(streamUrl);
            const streamName = "Camera";

            let u = {
                uid: uid,
                category: "point",
                callsign: streamName + "-" + this.point_num++,
                sidc: "",
                start_time: now,
                last_seen: now,
                stale_time: stale,
                type: "b-m-p-s-p-v", // CoT Camera Feed type
                lat: latlng.lat,
                lon: latlng.lng,
                hae: 0,
                speed: 0,
                course: 0,
                status: "",
                text: "Camera feed: " + streamUrl,
                parent_uid: "",
                parent_callsign: "",
                color: "#0066cc",
                send: true,
                local: true,
                isCamera: true,
                streamUrl: streamUrl,
                streamType: streamType
            }

            if (this.config && this.config.uid) {
                u.parent_uid = this.config.uid;
                u.parent_callsign = this.config.callsign;
            }

            let unit = new Unit(this, u);
            this.units.set(unit.uid, unit);
            unit.post();

            this.setCurrentUnitUid(u.uid, true);
        },

        showCameraStream: function (unit) {
            if (!unit.unit.isCamera && unit.unit.type !== "b-m-p-s-p-v") {
                console.log('Not a camera unit:', unit.unit);
                return;
            }

            console.log('Opening camera stream for:', unit.unit.callsign);
            console.log('Stream URL:', unit.unit.streamUrl);

            const streamUrl = unit.unit.streamUrl;

            if (!streamUrl) {
                console.error('No stream URL found for camera unit');
                alert('No stream URL configured for this camera');
                return;
            }

            // Determine stream type
            let streamType = 'video';
            if (streamUrl.includes(':9001/')) streamType = 'webrtc';
            else if (streamUrl.includes('.m3u8')) streamType = 'hls';
            else if (streamUrl.startsWith('rtsp://')) streamType = 'rtsp';

            // Set up currentVideo
            this.currentVideo = {
                url: streamUrl,
                visible: true,
                isLive: true,
                isWebRTC: streamType === 'webrtc',
                isHLS: streamType === 'hls',
                isRTSP: streamType === 'rtsp',
                title: unit.unit.callsign
            };

            console.log('Camera stream opened:', streamUrl, 'Type:', streamType);

            // Handle WebRTC streams (your MediaMTX server)
            if (streamType === 'webrtc') {
                this.$nextTick(() => {
                    this.handleWebRTCStream(unit, streamUrl);
                });
            } else if (streamType === 'hls') {
                this.$nextTick(() => {
                    this.handleHLSStream(unit, streamUrl);
                });
            }
        },

        async addFileRepositoryPoint(latlng) {
            const repoName = prompt("Enter file repository name:", "Files");
            if (!repoName) {
                return; // User cancelled
            }

            let uid = uuidv4();
            let now = new Date();
            let stale = new Date(now);
            stale.setDate(stale.getDate() + 365);

            let u = {
                uid: uid,
                category: "point",
                callsign: repoName + "-" + this.point_num++,
                sidc: "",
                start_time: now,
                last_seen: now,
                stale_time: stale,
                type: "b-m-p-s-p-f", // CoT File Repository type
                lat: latlng.lat,
                lon: latlng.lng,
                hae: 0,
                speed: 0,
                course: 0,
                status: "",
                // Store repository info in standard text field as JSON
                text: JSON.stringify({
                    description: "File repository",
                    repositoryName: repoName,
                    created: new Date().toISOString()
                }),
                parent_uid: "",
                parent_callsign: "",
                color: "#28a745",
                send: true,
                local: true,

                // Keep these for local client:
                isFileRepository: true,
                repositoryName: repoName
            }

            if (this.config && this.config.uid) {
                u.parent_uid = this.config.uid;
                u.parent_callsign = this.config.callsign;
            }

            let unit = new Unit(this, u);
            this.units.set(unit.uid, unit);
            unit.post();

            this.setCurrentUnitUid(u.uid, true);
        },

        async showFileRepository(unit) {
            if (!unit.unit.isFileRepository && unit.unit.type !== "b-m-p-s-p-f") {
                console.log('Not a file repository unit:', unit.unit);
                return;
            }

            console.log('Opening file repository for:', unit.unit.callsign);

            // Set current repository
            this.currentFileRepository = {
                unit: unit,
                visible: true,
                name: unit.unit.repositoryName || unit.unit.callsign,
                uid: unit.uid
            };

            // Load files for this repository
            await this.loadRepositoryFiles(unit.uid);
        },

        async loadRepositoryFiles(repositoryUid) {
            try {
                const response = await fetch('http://147.177.46.185:8080/Marti/sync/search');
                if (!response.ok) {
                    console.log('Cannot fetch from Marti API, status:', response.status);
                    this.repositoryFiles = [];
                    return;
                }

                const data = await response.json();
                const allFiles = data.results || [];

                // Filter files that belong to this repository
                this.repositoryFiles = allFiles.filter(file => {
                    return file.Keywords && file.Keywords.includes(repositoryUid) ||
                        file.FileName && file.FileName.includes(repositoryUid);
                });

                console.log('Found repository files:', this.repositoryFiles);
            } catch (error) {
                console.error('Failed to load repository files:', error);
                this.repositoryFiles = [];
            }
        },

        async uploadFilesToRepository() {
            if (!this.selectedFiles || this.selectedFiles.length === 0) {
                alert('Please select files to upload');
                return;
            }

            if (!this.currentFileRepository) {
                alert('No repository selected');
                return;
            }

            this.isUploading = true;
            const repositoryUid = this.currentFileRepository.uid;
            const successfulUploads = [];
            const failedUploads = [];

            for (let i = 0; i < this.selectedFiles.length; i++) {
                const file = this.selectedFiles[i];
                this.uploadProgress = Math.round(((i + 1) / this.selectedFiles.length) * 100);

                try {
                    // Add repository UID to filename to associate with this repository
                    const modifiedFileName = `${repositoryUid}_${file.name}`;

                    const formData = new FormData();

                    // Create a new file with the modified name
                    const renamedFile = new File([file], modifiedFileName, { type: file.type });

                    // Try 'file' as the field name (most common)
                    formData.append('assetFile', renamedFile);

                    // Also try adding the file with its name as the field name
                    // Some backends expect this format
                    formData.append(modifiedFileName, renamedFile);

                    // Add keywords to associate with repository
                    formData.append('keywords', repositoryUid);

                    // Some backends expect additional metadata
                    formData.append('filename', modifiedFileName);
                    formData.append('name', modifiedFileName);

                    // Try without the query parameter first
                    const response = await fetch('http://147.177.46.185:8080/Marti/sync/upload', {
                        method: 'POST',
                        body: formData
                    });

                    // If that fails, try with the name parameter
                    if (!response.ok && response.status === 406) {
                        // Create new FormData for second attempt
                        const formData2 = new FormData();
                        formData2.append('file', renamedFile);

                        response = await fetch('http://147.177.46.185:8080/Marti/sync/upload?name=' + encodeURIComponent(modifiedFileName), {
                            method: 'POST',
                            body: formData2
                        });
                    }

                    // If still failing, try raw file upload
                    if (!response.ok && response.status === 406) {
                        response = await fetch('http://147.177.46.185:8080/Marti/sync/upload?name=' + encodeURIComponent(modifiedFileName), {
                            method: 'POST',
                            headers: {
                                'Content-Type': file.type || 'application/octet-stream',
                            },
                            body: file // Send raw file data
                        });
                    }

                    if (response.ok) {
                        const result = await response.text();
                        console.log('File uploaded successfully:', result);
                        successfulUploads.push(file.name);
                    } else {
                        const errorText = await response.text();
                        console.error('Upload failed for:', file.name, response.status, errorText);
                        failedUploads.push(file.name);
                    }
                } catch (error) {
                    console.error('Upload error for:', file.name, error);
                    failedUploads.push(file.name);
                }
            }

            this.isUploading = false;
            this.uploadProgress = 0;
            this.selectedFiles = null;

            // Show results
            let message = `Upload complete!\nSuccessful: ${successfulUploads.length}`;
            if (failedUploads.length > 0) {
                message += `\nFailed: ${failedUploads.length}`;
                if (failedUploads.length <= 5) {
                    message += '\nFailed files: ' + failedUploads.join(', ');
                }
            }
            alert(message);

            // Reload repository files
            await this.loadRepositoryFiles(repositoryUid);
        },

        handleFileSelection(event) {
            this.selectedFiles = Array.from(event.target.files);
        },

        async downloadFile(file) {
            try {
                const downloadUrl = `http://147.177.46.185:8080/Marti/sync/content?hash=${file.Hash}`;

                // Create temporary link and trigger download
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = file.FileName.replace(/^[^_]*_/, ''); // Remove repository UID prefix
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (error) {
                console.error('Download failed:', error);
                alert('Download failed: ' + error.message);
            }
        },

        async viewFile(file) {
            if (file.MIMEType && file.MIMEType.startsWith('video/')) {
                // Open video in existing video overlay
                const videoUrl = `http://147.177.46.185:8080/Marti/sync/content?hash=${file.Hash}`;
                this.currentVideo = {
                    url: videoUrl,
                    visible: true,
                    title: file.FileName.replace(/^[^_]*_/, ''), // Remove repository UID prefix
                    isLive: false
                };
                // Hide file repository modal
                this.currentFileRepository.visible = false;
            } else if (file.MIMEType && file.MIMEType.startsWith('image/')) {
                // Open image in new tab/window
                const imageUrl = `http://147.177.46.185:8080/Marti/sync/content?hash=${file.Hash}`;
                window.open(imageUrl, '_blank');
            } else {
                // Download other file types
                await this.downloadFile(file);
            }
        },

        async deleteFile(file) {
            if (!confirm(`Are you sure you want to delete "${file.FileName.replace(/^[^_]*_/, '')}"?`)) {
                return;
            }

            try {
                // Note: Marti API might not have delete endpoint, this is a placeholder
                const response = await fetch(`http://147.177.46.185:8080/Marti/sync/delete?hash=${file.Hash}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    alert('File deleted successfully');
                    await this.loadRepositoryFiles(this.currentFileRepository.uid);
                } else {
                    alert('Delete failed: ' + response.status);
                }
            } catch (error) {
                console.error('Delete failed:', error);
                alert('Delete failed: ' + error.message);
            }
        },

        closeFileRepository() {
            this.currentFileRepository = null;
            this.repositoryFiles = [];
            this.selectedFiles = null;
            this.uploadProgress = 0;
            this.isUploading = false;
        },

        formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },

        getFileIcon(file) {
            if (!file.MIMEType) return 'bi-file-earmark';

            if (file.MIMEType.startsWith('video/')) return 'bi-file-play';
            if (file.MIMEType.startsWith('image/')) return 'bi-file-image';
            if (file.MIMEType.startsWith('audio/')) return 'bi-file-music';
            if (file.MIMEType.includes('pdf')) return 'bi-file-pdf';
            if (file.MIMEType.includes('word')) return 'bi-file-word';
            if (file.MIMEType.includes('excel') || file.MIMEType.includes('spreadsheet')) return 'bi-file-excel';
            if (file.MIMEType.includes('powerpoint') || file.MIMEType.includes('presentation')) return 'bi-file-ppt';
            if (file.MIMEType.includes('zip') || file.MIMEType.includes('rar') || file.MIMEType.includes('7z')) return 'bi-file-zip';

            return 'bi-file-earmark';
        },
        addCameraPoint: function (latlng) {
            const streamUrl = prompt("Enter stream URL (RTSP, HLS, WebRTC, or regular video):", "http://localhost:9001/webcam");
            if (!streamUrl) {
                return; // User cancelled
            }

            let uid = uuidv4();
            let now = new Date();
            let stale = new Date(now);
            stale.setDate(stale.getDate() + 365);

            // Simple stream type detection
            let streamType = 'video';
            if (streamUrl.toLowerCase().startsWith('rtsp://')) streamType = 'rtsp';
            else if (streamUrl.includes('.m3u8')) streamType = 'hls';
            else if (streamUrl.includes(':9001/')) streamType = 'webrtc';

            let u = {
                uid: uid,
                category: "point",
                callsign: "Camera-" + this.point_num++,
                sidc: "",
                start_time: now,
                last_seen: now,
                stale_time: stale,
                type: "b-m-p-s-p-v",
                lat: latlng.lat,
                lon: latlng.lng,
                hae: 0,
                speed: 0,
                course: 0,
                status: "",
                text: JSON.stringify({
                    description: "Camera feed",
                    streamUrl: streamUrl,
                    streamType: streamType
                }),
                parent_uid: "",
                parent_callsign: "",
                color: "#0066cc",
                send: true,
                local: true,
                isCamera: true,
                streamUrl: streamUrl,
                streamType: streamType
            }

            if (this.config && this.config.uid) {
                u.parent_uid = this.config.uid;
                u.parent_callsign = this.config.callsign;
            }

            let unit = new Unit(this, u);
            this.units.set(unit.uid, unit);
            unit.post();

            this.setCurrentUnitUid(u.uid, true);
        },

        async handleWebcamStream(unit) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 1280, height: 720 },
                    audio: false
                });

                this.webcamStream = stream;
                this.currentVideo.stream = stream;

                // Wait for DOM update
                await this.$nextTick();

                const videoElement = document.querySelector('.video-overlay video');
                if (videoElement) {
                    videoElement.srcObject = stream;
                    videoElement.play().catch(console.error);
                }
            } catch (error) {
                console.error('Error accessing webcam:', error);
                alert('Could not access webcam: ' + error.message);
            }
        },

        // Standalone recording functions
        async startStandaloneRecording() {
            try {
                // Get webcam stream
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 1280, height: 720 },
                    audio: true // Include audio for video recording
                });

                this.standaloneRecording.stream = stream;
                this.standaloneRecording.startTime = new Date();

                // Set up media recorder
                this.standaloneRecording.recorder = new MediaRecorder(stream, {
                    mimeType: 'video/webm;codecs=vp9'
                });

                this.standaloneRecording.chunks = [];

                this.standaloneRecording.recorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.standaloneRecording.chunks.push(event.data);
                    }
                };

                this.standaloneRecording.recorder.onstop = () => {
                    const blob = new Blob(this.standaloneRecording.chunks, { type: 'video/webm' });
                    this.saveStandaloneRecording(blob);
                    this.stopStandaloneRecording();
                };

                // Show recording overlay
                this.currentVideo = {
                    visible: true,
                    isWebcam: true,
                    isStandaloneRecording: true,
                    title: 'Recording Video...',
                    stream: stream
                };

                this.standaloneRecording.isActive = true;
                this.standaloneRecording.recorder.start();

                // Set up video element
                await this.$nextTick();
                const videoElement = document.querySelector('.video-overlay video');
                if (videoElement) {
                    videoElement.srcObject = stream;
                    videoElement.play().catch(console.error);
                }

                console.log('Standalone recording started');

            } catch (error) {
                console.error('Error starting recording:', error);
                alert('Could not access webcam: ' + error.message);
            }
        },

        stopStandaloneRecording() {
            if (this.standaloneRecording.recorder && this.standaloneRecording.isActive) {
                this.standaloneRecording.recorder.stop();
            }

            if (this.standaloneRecording.stream) {
                this.standaloneRecording.stream.getTracks().forEach(track => track.stop());
                this.standaloneRecording.stream = null;
            }

            this.standaloneRecording.isActive = false;
            console.log('Standalone recording stopped');
        },

        async saveStandaloneRecording(blob) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `webcam-recording-${timestamp}.webm`;

            try {
                console.log('Uploading standalone recording:', filename, 'Size:', blob.size);

                const formData = new FormData();
                formData.append('assetfile', blob, filename);

                // CRITICAL: Make sure browser detects this as multipart/form-data
                const response = await fetch(`http://147.177.46.185:8080/Marti/sync/upload?name=${encodeURIComponent(filename)}`, {
                    method: 'POST',
                    body: formData
                    // DO NOT set Content-Type header - browser must set it automatically with boundary
                });

                if (response.ok) {
                    const result = await response.text();
                    console.log('Recording saved successfully to data/videos:', result);
                    alert(`Recording saved successfully as ${filename}\n\nSaved to: data/videos/${filename}`);
                } else {
                    const errorText = await response.text();
                    console.error('Upload failed:', response.status, errorText);
                    throw new Error(`Upload failed: ${response.status} - ${errorText}`);
                }
            } catch (error) {
                console.error('Upload failed:', error);
                // Fallback: download to user's computer
                this.downloadRecording(blob, filename);
                alert('Upload to server failed, video downloaded to your computer instead.');
            }
        },

        downloadRecording(blob, filename) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            alert(`Recording downloaded as ${filename}`);
        },

        // Add this after the handleWebcamStream function
        startRecording() {
            if (this.webcamStream) {
                this.mediaRecorder = new MediaRecorder(this.webcamStream, {
                    mimeType: 'video/webm;codecs=vp9'
                });
                this.recordedChunks = [];

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.recordedChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = () => {
                    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
                    this.uploadRecordedVideo(blob);
                };

                this.mediaRecorder.start();
                this.isRecording = true;
                console.log('Recording started');
            } else {
                alert('No webcam stream available to record');
            }
        },

        stopRecording() {
            if (this.mediaRecorder && this.isRecording) {
                this.mediaRecorder.stop();
                this.isRecording = false;
                console.log('Recording stopped');
            }
        },

        async uploadRecordedVideo(blob) {
            if (!this.currentFileRepository) {
                // Create a default filename
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `webcam-recording-${timestamp}.webm`;

                // Create download link
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                alert('Recording saved to downloads folder');
                return;
            }

            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `${this.currentFileRepository.uid}_webcam-recording-${timestamp}.webm`;

                const formData = new FormData();
                formData.append('assetfile', blob, filename);
                formData.append('keywords', this.currentFileRepository.uid);
                formData.append('filename', filename);

                const response = await fetch('http://147.177.46.185:8080/Marti/sync/upload', {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    alert('Recording uploaded to file repository successfully');
                    await this.loadRepositoryFiles(this.currentFileRepository.uid);
                } else {
                    throw new Error(`Upload failed: ${response.status}`);
                }
            } catch (error) {
                console.error('Upload failed:', error);
                alert('Upload failed: ' + error.message);
            }
        },

        async handleWebRTCStream(unit, streamUrl) {
            console.log('Handling WebRTC stream');
            await this.$nextTick();

            try {
                await this.setupWebRTCPlayer(streamUrl);
            } catch (error) {
                console.error('WebRTC setup failed:', error);
                alert('WebRTC connection failed: ' + error.message);
            }
        },

        async setupWebRTCPlayer(streamUrl) {
            const videoElement = document.querySelector('.video-overlay video');
            if (!videoElement) {
                throw new Error('Video element not found');
            }

            console.log('Setting up WebRTC for video element:', videoElement);

            // Clean up existing connection
            if (this.webrtcPeerConnection) {
                this.webrtcPeerConnection.close();
            }

            this.webrtcPeerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            this.webrtcPeerConnection.ontrack = (event) => {
                console.log('Received WebRTC track');
                videoElement.srcObject = event.streams[0];
                videoElement.play().catch(console.error);
            };

            const offer = await this.webrtcPeerConnection.createOffer();
            await this.webrtcPeerConnection.setLocalDescription(offer);

            // FIX: Clean up URL and build WHEP endpoint properly
            const cleanUrl = streamUrl.replace(/\/$/, ''); // Remove trailing slash
            const whepUrl = cleanUrl + '/whep';

            console.log('Connecting to WHEP endpoint:', whepUrl);

            // Connect to MediaMTX WebRTC endpoint
            const response = await fetch(whepUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: offer.sdp
            });

            if (response.ok) {
                const answerSdp = await response.text();
                await this.webrtcPeerConnection.setRemoteDescription({
                    type: 'answer',
                    sdp: answerSdp
                });
                console.log('WebRTC connection established');
            } else {
                const errorText = await response.text();
                console.error('WHEP response:', response.status, errorText);
                throw new Error(`WebRTC connection failed: ${response.status} - ${errorText}`);
            }
        },

        async handleHLSStream(unit, streamUrl) {
            console.log('Handling HLS stream');
            await this.$nextTick();
            await new Promise(resolve => setTimeout(resolve, 100));
            this.setupHLSPlayback(streamUrl);
        },

        setupHLSPlayback(streamUrl) {
            const videoElement = document.querySelector('.video-overlay video');
            if (!videoElement) {
                console.error('Video element not found');
                return;
            }

            // Check if HLS.js is available
            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                if (this.hlsInstance) {
                    this.hlsInstance.destroy();
                }

                this.hlsInstance = new Hls({
                    debug: false,
                    lowLatencyMode: true
                });

                this.hlsInstance.loadSource(streamUrl);
                this.hlsInstance.attachMedia(videoElement);

                this.hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                    videoElement.play().catch(console.error);
                });

                this.hlsInstance.on(Hls.Events.ERROR, (event, data) => {
                    console.error('HLS error:', data);
                    if (data.fatal) {
                        alert('HLS playback error: ' + data.details);
                    }
                });
            } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari native HLS
                videoElement.src = streamUrl;
                videoElement.play().catch(console.error);
            } else {
                alert('HLS playback not supported. Please include HLS.js library.');
            }
        },

        async handleRegularVideo(unit, streamUrl) {
            console.log('Handling regular video');
            await this.$nextTick();
        },

        stopVideo() {
            console.log('Stopping video playback');

            // Stop standalone recording if active
            if (this.standaloneRecording.isActive) {
                this.stopStandaloneRecording();
            }

            // Stop recording if active
            if (this.isRecording) {
                this.stopRecording();
            }

            // Clean up WebRTC
            if (this.webrtcPeerConnection) {
                this.webrtcPeerConnection.close();
                this.webrtcPeerConnection = null;
            }

            // Clean up HLS
            if (this.hlsInstance) {
                this.hlsInstance.destroy();
                this.hlsInstance = null;
            }

            // Clean up webcam
            this.destroyWebcamStream();

            // Clean up video element
            const videoElement = document.querySelector('.video-overlay video');
            if (videoElement) {
                videoElement.pause();
                videoElement.src = '';
                videoElement.srcObject = null;
                videoElement.load();
            }

            // Hide video modal
            if (this.currentVideo) {
                this.currentVideo.visible = false;
            }
        },

        destroyWebcamStream() {
            if (this.webcamStream) {
                this.webcamStream.getTracks().forEach(track => track.stop());
                this.webcamStream = null;
            }
        },

        // Helper method to create the 4 special point types
        createSpecialPoint: function (latlng, name, type, text, color) {
            let uid = uuidv4();
            let now = new Date();
            let stale = new Date(now);
            stale.setDate(stale.getDate() + 365);

            let u = {
                uid: uid,
                category: "point",
                callsign: name + "-" + this.point_num++,
                sidc: "",
                start_time: now,
                last_seen: now,
                stale_time: stale,
                type: type,
                lat: latlng.lat,
                lon: latlng.lng,
                hae: 0,
                speed: 0,
                course: 0,
                status: "",
                text: text,
                parent_uid: "",
                parent_callsign: "",
                color: color,
                send: true,
                local: true,
            }

            if (this.config && this.config.uid) {
                u.parent_uid = this.config.uid;
                u.parent_callsign = this.config.callsign;
            }

            let unit = new Unit(this, u);
            this.units.set(unit.uid, unit);
            unit.post();

            this.setCurrentUnitUid(u.uid, true);
        },

        // Toggle multi-select mode
        toggleMultiSelect: function () {
            this.multiSelectMode = !this.multiSelectMode;
            if (!this.multiSelectMode) {
                // Clear selections when exiting multi-select
                this.selectedUnits.clear();
                this.redrawAllMarkers();
            } else {
                // When entering multi-select mode, automatically switch to select tool
                const selectRadio = document.getElementById('select');
                if (selectRadio) {
                    selectRadio.checked = true;
                }
            }
        },

        toggleUnitSelection: function (uid) {
            if (this.selectedUnits.has(uid)) {
                this.selectedUnits.delete(uid);
            } else {
                this.selectedUnits.add(uid);
            }
            // Update visual indicator
            let unit = this.units.get(uid);
            if (unit) {
                unit.updateMarker();
            }
        },

        deleteSelectedUnits: function () {
            if (this.selectedUnits.size === 0) return;

            if (confirm(`Delete ${this.selectedUnits.size} selected items?`)) {
                let deletePromises = [];
                this.selectedUnits.forEach(uid => {
                    deletePromises.push(
                        fetch("/api/unit/" + uid, { method: "DELETE" })
                    );
                });

                Promise.all(deletePromises).then(() => {
                    this.selectedUnits.clear();
                    this.multiSelectMode = false;
                    this.fetchAllUnits();
                });
            }
        },

        redrawAllMarkers: function () {
            this.units.forEach(unit => {
                unit.updateMarker();
            });
        },

        clearAllPoints: function () {
            // Get all units that are points (any category that's not contact or unit)
            const pointUnits = Array.from(this.units.values())
                .filter(u => u.unit.category === 'point') // This includes fires, hazards, water points, observation points, etc.
                .map(u => u.uid);

            if (pointUnits.length === 0) {
                alert('No points to clear');
                return;
            }

            if (confirm(`Are you sure you want to clear all ${pointUnits.length} points? This includes fires, hazards, water sources, observation points, and all other map points.`)) {
                console.log('Clearing all points:', pointUnits);

                // Delete each point with better error handling
                let deletePromises = pointUnits.map(uid => {
                    console.log('Deleting point:', uid);
                    return fetch("/api/unit/" + uid, { method: "DELETE" })
                        .then(response => {
                            if (!response.ok) {
                                console.error(`Failed to delete point ${uid}:`, response.status);
                                return false;
                            }
                            return true;
                        })
                        .catch(error => {
                            console.error(`Error deleting point ${uid}:`, error);
                            return false;
                        });
                });

                Promise.all(deletePromises)
                    .then(results => {
                        const successful = results.filter(r => r === true).length;
                        const failed = results.filter(r => r === false).length;

                        console.log(`Deleted ${successful} points, ${failed} failed`);

                        // Clear from local state immediately
                        pointUnits.forEach(uid => {
                            this.removeUnit(uid);
                        });

                        // Refresh from server
                        this.fetchAllUnits();

                        if (failed > 0) {
                            alert(`${successful} points cleared, ${failed} failed. Check console for details.`);
                        } else {
                            alert(`${successful} points cleared successfully`);
                        }
                    })
                    .catch(error => {
                        console.error('Error clearing points:', error);
                        alert('Error clearing points. Check console for details.');
                        this.fetchAllUnits();
                    });
            }
        },

        formFromUnit: function (u) {
            if (!u) {
                this.form_unit = {
                    callsign: "",
                    category: "",
                    type: "",
                    subtype: "",
                    aff: "",
                    text: "",
                    send: false,
                    root_sidc: null,
                };
            } else {
                this.form_unit = {
                    callsign: u.unit.callsign,
                    category: u.unit.category,
                    type: u.unit.type,
                    subtype: "G",
                    aff: "h",
                    text: u.unit.text,
                    send: u.unit.send,
                    root_sidc: this.types,
                };

                if (u.unit.type.startsWith('a-')) {
                    this.form_unit.type = 'b-m-p-s-m';
                    this.form_unit.aff = u.unit.type.substring(2, 3);
                    this.form_unit.subtype = u.unit.type.substring(4);
                    this.form_unit.root_sidc = this.getRootSidc(u.unit.type.substring(4))
                }
            }
        },

        saveEditForm: function () {
            let u = this.getCurrentUnit();
            if (!u) return;

            u.unit.callsign = this.form_unit.callsign;
            u.unit.category = this.form_unit.category;
            u.unit.send = this.form_unit.send;
            u.unit.text = this.form_unit.text;

            if (this.form_unit.category === "unit") {
                u.unit.type = ["a", this.form_unit.aff, this.form_unit.subtype].join('-');
                u.unit.sidc = this.sidcFromType(u.unit.type);
            } else {
                u.unit.type = this.form_unit.type;
                u.unit.sidc = "";
            }

            u.redraw = true;
            u.updateMarker();
            u.post();
        },

        getRootSidc: function (s) {
            let curr = this.types;

            for (; ;) {
                if (!curr?.next) {
                    return null;
                }

                let found = false;
                for (const k of curr.next) {
                    if (k.code === s) {
                        return curr;
                    }

                    if (s.startsWith(k.code)) {
                        curr = k;
                        found = true;
                        break
                    }
                }
                if (!found) {
                    return null;
                }
            }
        },

        getSidc: function (s) {
            let curr = this.types;

            if (s === "") {
                return curr;
            }

            for (; ;) {
                if (!curr?.next) {
                    return null;
                }

                for (const k of curr.next) {
                    if (k.code === s) {
                        return k;
                    }

                    if (s.startsWith(k.code)) {
                        curr = k;
                        break
                    }
                }
            }
        },

        setFormRootSidc: function (s) {
            let t = this.getSidc(s);
            if (t?.next) {
                this.form_unit.root_sidc = t;
                this.form_unit.subtype = t.next[0].code;
            } else {
                this.form_unit.root_sidc = this.types;
                this.form_unit.subtype = this.types.next[0].code;
            }
        },

        removeTool: function (name) {
            if (this.tools.has(name)) {
                let p = this.tools.get(name);
                map.removeLayer(p);
                p.remove();
                this.tools.delete(name);
                this.ts++;
            }
        },

        getTool: function (name) {
            return this.tools.get(name);
        },

        addOrMove(name, coord, icon) {
            if (this.tools.has(name)) {
                this.tools.get(name).setLatLng(coord);
            } else {
                let p = new L.marker(coord).addTo(map);
                if (icon) {
                    p.setIcon(L.icon({
                        iconUrl: icon,
                        iconSize: [20, 20],
                        iconAnchor: new L.Point(10, 10),
                    }));
                }
                this.tools.set(name, p);
            }
            this.ts++;
        },

        printCoordsll: function (latlng) {
            return this.printCoords(latlng.lat, latlng.lng);
        },

        printCoords: function (lat, lng) {
            return lat.toFixed(6) + "," + lng.toFixed(6);
        },

        latlng: function (lat, lon) {
            return L.latLng(lat, lon);
        },

        distBea: function (p1, p2) {
            let toRadian = Math.PI / 180;
            // haversine formula
            // bearing
            let y = Math.sin((p2.lng - p1.lng) * toRadian) * Math.cos(p2.lat * toRadian);
            let x = Math.cos(p1.lat * toRadian) * Math.sin(p2.lat * toRadian) - Math.sin(p1.lat * toRadian) * Math.cos(p2.lat * toRadian) * Math.cos((p2.lng - p1.lng) * toRadian);
            let brng = Math.atan2(y, x) * 180 / Math.PI;
            brng += brng < 0 ? 360 : 0;
            // distance
            let R = 6371000; // meters
            let deltaF = (p2.lat - p1.lat) * toRadian;
            let deltaL = (p2.lng - p1.lng) * toRadian;
            let a = Math.sin(deltaF / 2) * Math.sin(deltaF / 2) + Math.cos(p1.lat * toRadian) * Math.cos(p2.lat * toRadian) * Math.sin(deltaL / 2) * Math.sin(deltaL / 2);
            let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            let distance = R * c;
            return (distance < 10000 ? distance.toFixed(0) + "m " : (distance / 1000).toFixed(1) + "km ") + brng.toFixed(1) + "°T";
        },

        contactsNum: function () {
            let online = 0;
            let total = 0;
            this.units.forEach(function (u) {
                if (u.isContact()) {
                    if (u.isOnline()) online += 1;
                    total += 1;
                }
            })

            return online + "/" + total;
        },

        countByCategory: function (s) {
            let total = 0;
            this.units.forEach(function (u) {
                if (u.unit.category === s) total += 1;
            })

            return total;
        },

        msgNum: function (all) {
            if (!this.messages) return 0;
            let n = 0;
            for (const [key, value] of Object.entries(this.messages)) {
                if (value.messages) {
                    for (m of value.messages) {
                        if (all || !this.seenMessages.has(m.message_id)) n++;
                    }
                }
            }
            return n;
        },

        msgNum1: function (uid, all) {
            if (!this.messages || !this.messages[uid].messages) return 0;
            let n = 0;
            for (m of this.messages[uid].messages) {
                if (all || !this.seenMessages.has(m.message_id)) n++;
            }
            return n;
        },

        openChat: function (uid, chatroom) {
            this.chat_uid = uid;
            this.chatroom = chatroom;
            new bootstrap.Modal(document.getElementById('messages')).show();

            if (this.messages[this.chat_uid]) {
                for (m of this.messages[this.chat_uid].messages) {
                    this.seenMessages.add(m.message_id);
                }
            }
        },

        getStatus: function (uid) {
            return this.ts && this.units.get(uid)?.unit?.status;
        },

        getMessages: function () {
            if (!this.chat_uid) {
                return [];
            }

            let msgs = this.messages[this.chat_uid] ? this.messages[this.chat_uid].messages : [];

            if (document.getElementById('messages').style.display !== 'none') {
                for (m of msgs) {
                    this.seenMessages.add(m.message_id);
                }
            }

            return msgs;
        },

        cancelEditForm: function () {
            this.formFromUnit(this.getCurrentUnit());
        },

        sidcFromType: function (s) {
            if (!s || !s.startsWith('a-')) return "";

            let n = s.split('-');

            let sidc = 'S' + n[1];

            if (n.length > 2) {
                sidc += n[2] + 'P';
            } else {
                sidc += '-P';
            }

            if (n.length > 3) {
                for (let i = 3; i < n.length; i++) {
                    if (n[i].length > 1) {
                        break
                    }
                    sidc += n[i];
                }
            }

            if (sidc.length < 10) {
                sidc += '-'.repeat(10 - sidc.length);
            }

            return sidc.toUpperCase();
        },

        deleteCurrentUnit: function () {
            if (!this.current_unit_uid) return;
            fetch("/api/unit/" + this.current_unit_uid, { method: "DELETE" });
        },

        sendMessage: function () {
            let msg = {
                from: this.config.callsign,
                from_uid: this.config.uid,
                chatroom: this.chatroom,
                to_uid: this.chat_uid,
                text: this.chat_msg,
            };
            this.chat_msg = "";

            const requestOptions = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(msg)
            };
            let vm = this;
            fetch("/api/message", requestOptions)
                .then(resp => resp.json())
                .then(d => vm.messages = d);
        }
    },

    beforeUnmount() {
        if (this.webrtcPeerConnection) {
            this.webrtcPeerConnection.close();
        }
        if (this.hlsInstance) {
            this.hlsInstance.destroy();
        }
        this.destroyWebcamStream();
    }
});

app.mount('#app');

class Unit {
    constructor(app, u) {
        this.app = app;
        this.unit = u;
        this.uid = u.uid;
        this.updateMarker();
    }

    update(u) {
        if (this.unit.uid !== u.uid) {
            throw "wrong uid";
        }

        this.redraw = this.needsRedraw(u);

        for (const k of Object.keys(u)) {
            this.unit[k] = u[k];
        }

        this.updateMarker();

        return this;
    }

    needsRedraw(u) {
        if (this.unit.type !== u.type || this.unit.sidc !== u.sidc || this.unit.status !== u.status) return true;
        if (this.unit.speed !== u.speed || this.unit.direction !== u.direction) return true;
        if (this.unit.team !== u.team || this.unit.role !== u.role) return true;

        if (this.unit.sidc.charAt(2) === 'A' && this.unit.hae !== u.hae) return true;
        return false;
    }

    isContact() {
        return this.unit.category === "contact"
    }

    isOnline() {
        return this.unit.status === "Online";
    }

    name() {
        let res = this.unit?.callsign || "no name";
        if (this.unit.parent_uid === this.app.config?.uid) {
            if (this.unit.send) {
                res = "+ " + res;
            } else {
                res = "* " + res;
            }
        }
        return res;
    }

    removeMarker() {
        if (this.marker) {
            map.removeLayer(this.marker);
            this.marker.remove();
            this.marker = null;
        }
    }

    updateMarker() {
        if (!this.hasCoords()) {
            this.removeMarker();
            return;
        }

        if (this.marker) {
            if (this.redraw) {
                this.marker.setIcon(getIcon(this.unit, true));
            }
            // Add visual indicator for selected state
            this.marker.setOpacity(this.app.selectedUnits.has(this.uid) ? 0.5 : 1.0);
        } else {
            this.marker = L.marker(this.coords(), { draggable: this.unit.local ? 'true' : 'false' });
            this.marker.setIcon(getIcon(this.unit, true));

            let vm = this;
            this.marker.on('click', function (e) {
                if (vm.app.multiSelectMode) {
                    vm.app.toggleUnitSelection(vm.uid);
                } else {
                    // Check if this is a camera unit
                    if (vm.unit.isCamera || vm.unit.type === "b-m-p-s-p-v") {
                        vm.app.showCameraStream(vm);
                    } else if (vm.unit.isFileRepository || vm.unit.type === "b-m-p-s-p-f") {
                        // Check if this is a file repository unit
                        vm.app.showFileRepository(vm);
                    } else {
                        vm.app.setCurrentUnitUid(vm.uid, false);
                    }
                }
            });

            if (this.unit.local) {
                this.marker.on('dragend', function (e) {
                    vm.unit.lat = e.target.getLatLng().lat;
                    vm.unit.lon = e.target.getLatLng().lng;
                });
            }

            this.marker.addTo(map);
        }

        this.marker.setLatLng(this.coords());
        this.marker.bindTooltip(this.popup());
        this.redraw = false;
    }

    hasCoords() {
        return this.unit.lat && this.unit.lon;
    }

    coords() {
        return [this.unit.lat, this.unit.lon];
    }

    latlng() {
        return L.latLng(this.unit.lat, this.unit.lon)
    }

    compare(u2) {
        return this.unit.callsign.toLowerCase().localeCompare(u2.unit.callsign.toLowerCase());
    }

    popup() {
        let v = '<b>' + this.unit.callsign + '</b><br/>';
        if (this.unit.team) v += this.unit.team + ' ' + this.unit.role + '<br/>';
        if (this.unit.speed) v += 'Speed: ' + this.unit.speed.toFixed(0) + ' m/s<br/>';
        if (this.unit.sidc.charAt(2) === 'A') {
            v += "hae: " + this.unit.hae.toFixed(0) + " m<br/>";
        }
        v += this.unit.text.replaceAll('\n', '<br/>').replaceAll('; ', '<br/>');
        return v;
    }

    post() {
        const requestOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.unit)
        };
        let vm = this;
        fetch("/api/unit", requestOptions)
            .then(resp => resp.json())
            .then(d => vm.app.processUnit(d));
    }
}