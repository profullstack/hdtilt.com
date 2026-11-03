' hdtilt on Roku. Everything comes from hdtilt.com:
'   /oauth/device_authorization + /oauth/token   sign in with a code (src/server/tv.js)
'   /api/library                                 the account's playlists and favorites
'   /api/tv/load | channels | vod                groups and pages, with Roku play URLs

sub init()
    m.pending = {}
    m.linkGroup = m.top.findNode("linkGroup")
    m.linkCode = m.top.findNode("linkCode")
    m.linkUrl = m.top.findNode("linkUrl")
    m.linkNote = m.top.findNode("linkNote")
    m.message = m.top.findNode("message")
    m.browse = m.top.findNode("browse")
    m.playlistName = m.top.findNode("playlistName")
    m.rail = m.top.findNode("rail")
    m.listHead = m.top.findNode("listHead")
    m.listNode = m.top.findNode("list")
    m.video = m.top.findNode("video")
    m.banner = m.top.findNode("banner")
    m.pollTimer = m.top.findNode("pollTimer")
    m.focusTimer = m.top.findNode("focusTimer")
    m.bannerTimer = m.top.findNode("bannerTimer")

    m.pollTimer.observeField("fire", "onPollTimer")
    m.focusTimer.observeField("fire", "onFocusTimer")
    m.bannerTimer.observeField("fire", "onBannerTimer")
    m.rail.observeField("itemFocused", "onRailFocused")
    m.rail.observeField("itemSelected", "onRailSelected")
    m.listNode.observeField("itemFocused", "onListFocused")
    m.listNode.observeField("itemSelected", "onListSelected")
    m.video.observeField("state", "onVideoState")

    m.launched = false
    m.retry = ""
    m.list = invalid
    m.listReturn = invalid
    m.playing = invalid
    m.railMode = "main"
    m.dialogKind = ""

    if regRead("refresh") = invalid then
        startLink()
    else
        loadLibrary()
    end if
end sub

' Roku certification: tell the OS once the first screen is up.
sub launched()
    if m.launched then return
    m.launched = true
    m.top.signalBeacon("AppLaunchComplete")
end sub

' ---------------------------------------------------------------- requests

sub api(req as object, name as string)
    t = CreateObject("roSGNode", "ApiTask")
    t.tag = name
    t.request = req
    t.observeField("response", "onApi")
    t.control = "RUN"
    m.pending[name] = t ' a newer request with the same name wins
end sub

sub onApi(msg as object)
    t = msg.getRoSGNode()
    name = t.tag
    cur = m.pending[name]
    if cur = invalid then return
    if not cur.isSameNode(t) then return
    m.pending.Delete(name)
    res = msg.getData()
    if res.error = "signin" then
        startLink()
        return
    end if
    if name = "device" then
        onDevice(res)
    else if name = "poll" then
        onPoll(res)
    else if name = "library" then
        onLibrary(res)
    else if name = "load" then
        onLoad(res)
    else if name = "list" then
        onList(res)
    else if name = "cats" then
        onCats(res)
    end if
end sub

sub showMessage(text as string, retry as string)
    m.retry = retry
    m.linkGroup.visible = false
    m.browse.visible = false
    m.message.text = text
    m.message.visible = true
    m.message.setFocus(true)
    launched()
end sub

function errText(res as object) as string
    if res.error <> invalid and res.error <> "" then return res.error
    return "Something went wrong."
end function

' ---------------------------------------------------------------- sign in

sub startLink()
    stopVideo()
    regDelete("access")
    regDelete("refresh")
    m.pollTimer.control = "stop"
    m.message.visible = false
    m.browse.visible = false
    m.linkCode.text = "…"
    m.linkNote.text = ""
    m.linkGroup.visible = true
    m.linkGroup.setFocus(true)
    launched()
    api({ method: "POST", path: "/oauth/device_authorization", form: { client_id: "hdtilt-tv" } }, "device")
end sub

sub onDevice(res as object)
    if res.status <> 200 or type(res.data) <> "roAssociativeArray" then
        m.linkCode.text = ""
        m.linkNote.text = errText(res) + " Press OK to try again."
        m.retry = "link"
        return
    end if
    m.device = res.data
    m.linkCode.text = res.data.user_code
    shown = res.data.verification_uri
    shown = shown.Replace("https://", "").Replace("http://", "")
    m.linkUrl.text = "On your phone or computer, go to " + shown
    m.retry = ""
    interval = 5
    if res.data.interval <> invalid then interval = res.data.interval
    m.pollTimer.duration = interval
    m.pollTimer.control = "start"
end sub

sub onPollTimer()
    if m.device = invalid then return
    if m.pending["poll"] <> invalid then return
    form = { client_id: "hdtilt-tv", device_code: m.device.device_code }
    form["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code"
    api({ method: "POST", path: "/oauth/token", form: form }, "poll")
end sub

sub onPoll(res as object)
    if res.status = 200 and type(res.data) = "roAssociativeArray" and res.data.access_token <> invalid then
        m.pollTimer.control = "stop"
        regWrite("access", res.data.access_token)
        regWrite("refresh", res.data.refresh_token)
        m.device = invalid
        loadLibrary()
        return
    end if
    e = res.error
    if e = "authorization_pending" or e = "slow_down" or res.status = 0 or res.status = 429 then return
    m.pollTimer.control = "stop"
    if e = "access_denied" then
        startLink()
        m.linkNote.text = "That sign-in was refused. Here is a new code."
    else
        startLink() ' expired: a fresh code
    end if
end sub

' ---------------------------------------------------------------- library

sub loadLibrary()
    m.linkGroup.visible = false
    showMessage("Loading your playlists…", "")
    api({ method: "GET", path: "/api/library", auth: true }, "library")
end sub

sub onLibrary(res as object)
    if res.status = 423 then
        showMessage("Your hdtilt library is locked." + Chr(10) + "On hdtilt.com, open Account and unlock your key vault, then press OK here.", "library")
        return
    end if
    if res.status <> 200 then
        showMessage(errText(res) + Chr(10) + "Press OK to try again.", "library")
        return
    end if
    data = invalid
    if type(res.data) = "roAssociativeArray" then data = res.data.data
    deleted = {}
    if type(data) = "roAssociativeArray" and type(data.deleted) = "roArray" then
        for each id in data.deleted
            deleted[id] = true
        end for
    end if
    m.playlists = []
    if type(data) = "roAssociativeArray" and type(data.playlists) = "roArray" then
        for each p in data.playlists
            if type(p.source) = "roAssociativeArray" and not deleted.DoesExist(p.id) then
                t = p.source.type
                if t = "m3u" or t = "xtream" then m.playlists.push(p)
            end if
        end for
    end if
    if m.playlists.Count() = 0 then
        showMessage("No playlists yet." + Chr(10) + "Add your M3U or Xtream playlist at hdtilt.com, then press OK here.", "library")
        return
    end if
    m.favorites = {}
    if type(data.favorites) = "roAssociativeArray" then m.favorites = data.favorites
    pick = m.playlists[0]
    want = regRead("playlist")
    for each p in m.playlists
        if want <> invalid and p.id = want then pick = p
    end for
    openPlaylist(pick)
end sub

sub openPlaylist(pl as object)
    m.pl = pl
    m.favs = []
    f = m.favorites[pl.id]
    if type(f) = "roArray" then m.favs = f
    showMessage("Loading " + pl.name + "…" + Chr(10) + "A big playlist takes a few seconds.", "")
    api({ method: "POST", path: "/api/tv/load", body: { source: pl.source }, auth: true }, "load")
end sub

sub onLoad(res as object)
    if res.status <> 200 or type(res.data) <> "roAssociativeArray" then
        showMessage("Could not load " + m.pl.name + ": " + errText(res) + Chr(10) + "Press OK to try again, or * for options.", "load")
        return
    end if
    m.media = res.data.media
    m.groups = res.data.groups
    m.vod = res.data.vod = true
    m.total = res.data.total
    m.playlistName.text = m.pl.name
    m.message.visible = false
    m.browse.visible = true
    buildMainRail()
    m.rail.setFocus(true)
    launched()
    openRailEntry(0, false)
end sub

' ---------------------------------------------------------------- the rail

sub setRail(entries as object)
    m.railEntries = entries
    content = CreateObject("roSGNode", "ContentNode")
    for each e in entries
        c = content.createChild("ContentNode")
        c.title = e.label
    end for
    m.rail.content = content
    m.rail.jumpToItem = 0
end sub

sub buildMainRail()
    m.railMode = "main"
    e = []
    if m.favs.Count() > 0 then e.push({ kind: "favorites", label: "★ Favorites" })
    e.push({ kind: "all", label: "All channels" })
    e.push({ kind: "search", label: "Search" })
    if m.vod then
        e.push({ kind: "vod", label: "Movies", value: "movie" })
        e.push({ kind: "vod", label: "Shows", value: "series" })
    end if
    if type(m.groups) = "roArray" then
        for each g in m.groups
            e.push({ kind: "group", label: g.name, value: g.name })
        end for
    end if
    e.push({ kind: "options", label: "Options" })
    setRail(e)
end sub

sub onRailFocused()
    ' Browsing the rail previews its list, a moment after it settles.
    m.focusTimer.control = "stop"
    m.focusTimer.control = "start"
end sub

sub onFocusTimer()
    if not m.rail.hasFocus() then return
    openRailEntry(m.rail.itemFocused, false)
end sub

sub onRailSelected()
    openRailEntry(m.rail.itemSelected, true)
end sub

function isListEntry(e as object) as boolean
    return e.kind = "favorites" or e.kind = "all" or e.kind = "group" or e.kind = "vodcat"
end function

sub openRailEntry(i as integer, selected as boolean)
    if m.railEntries = invalid or i < 0 or i >= m.railEntries.Count() then return
    e = m.railEntries[i]
    if isListEntry(e) then
        key = e.kind + ":" + Str(i)
        if m.list = invalid or m.list.key <> key then
            if e.kind = "favorites" then
                loadList(key, "channels", "/api/tv/channels", { source: m.pl.source, ids: m.favs }, "Favorites")
            else if e.kind = "all" then
                loadList(key, "channels", "/api/tv/channels", { source: m.pl.source }, "All channels")
            else if e.kind = "group" then
                loadList(key, "channels", "/api/tv/channels", { source: m.pl.source, group: e.value }, e.value)
            else if e.kind = "vodcat" then
                loadList(key, "titles", "/api/tv/vod", { source: m.pl.source, kind: m.vodKind, category: e.value }, e.label)
            end if
        end if
        if selected and m.listNode.content <> invalid and m.listNode.content.getChildCount() > 0 then m.listNode.setFocus(true)
        return
    end if
    if not selected then return
    if e.kind = "search" then
        askSearch("Search channels", "channels")
    else if e.kind = "vodsearch" then
        if m.vodKind = "series" then
            askSearch("Search shows", "titles")
        else
            askSearch("Search movies", "titles")
        end if
    else if e.kind = "vod" then
        openVod(e.value, e.label)
    else if e.kind = "back" then
        buildMainRail()
    else if e.kind = "options" then
        showOptions()
    end if
end sub

' Movies or Shows: the rail turns into that kind's categories.
sub openVod(kind as string, label as string)
    m.vodKind = kind
    m.vodLabel = label
    m.listHead.text = label + " · loading categories…"
    api({ method: "POST", path: "/api/tv/vod", body: { source: m.pl.source, kind: kind }, auth: true }, "cats")
end sub

sub onCats(res as object)
    if res.status <> 200 or type(res.data) <> "roAssociativeArray" then
        m.listHead.text = m.vodLabel + ": " + errText(res)
        return
    end if
    m.railMode = "vod"
    e = [{ kind: "back", label: "‹ Live TV" }, { kind: "vodsearch", label: "Search " + LCase(m.vodLabel) }]
    if type(res.data.categories) = "roArray" then
        for each c in res.data.categories
            e.push({ kind: "vodcat", label: c.name, value: c.id })
        end for
    end if
    setRail(e)
    m.listHead.text = m.vodLabel + " · pick a category"
    m.listNode.content = CreateObject("roSGNode", "ContentNode")
    m.list = invalid
end sub

' ---------------------------------------------------------------- the list

sub loadList(key as string, kind as string, path as string, body as object, title as string)
    m.list = { key: key, kind: kind, path: path, body: body, title: title, items: [], total: -1, loading: false }
    m.listReturn = invalid
    m.listNode.content = CreateObject("roSGNode", "ContentNode")
    m.listHead.text = title + " · loading…"
    fetchMore()
end sub

sub fetchMore()
    l = m.list
    if l = invalid or l.loading then return
    if l.total >= 0 and l.items.Count() >= l.total then return
    body = {}
    body.Append(l.body)
    body.offset = l.items.Count()
    body.limit = 100
    l.loading = true
    api({ method: "POST", path: l.path, body: body, auth: true }, "list")
end sub

function subLine(it as object) as string
    if it.chno <> invalid then return it.chno.ToStr()
    if it.season <> invalid and it.episode <> invalid then return "S" + it.season.ToStr() + " E" + it.episode.ToStr()
    if it.year <> invalid then return it.year.ToStr()
    return ""
end function

sub addItems(items as object)
    content = m.listNode.content
    for each it in items
        m.list.items.push(it)
        c = content.createChild("ContentNode")
        c.title = it.name
        c.shortDescriptionLine1 = subLine(it)
        if type(it.logo) = "roString" or type(it.logo) = "String" then c.HDPosterUrl = it.logo
    end for
end sub

sub onList(res as object)
    l = m.list
    if l = invalid then return
    l.loading = false
    if res.status <> 200 or type(res.data) <> "roAssociativeArray" then
        m.listHead.text = l.title + ": " + errText(res)
        return
    end if
    if l.kind = "episodes" then
        eps = []
        if type(res.data.show) = "roAssociativeArray" and type(res.data.show.episodes) = "roArray" then eps = res.data.show.episodes
        addItems(eps)
        l.total = eps.Count()
    else
        if type(res.data.items) = "roArray" then addItems(res.data.items)
        l.total = l.items.Count()
        if res.data.total <> invalid then l.total = res.data.total
    end if
    if l.total = 0 then
        m.listHead.text = l.title + " · nothing here"
    else
        m.listHead.text = l.title + " · " + l.total.ToStr()
    end if
end sub

sub onListFocused()
    if m.list = invalid then return
    if m.listNode.itemFocused >= m.list.items.Count() - 20 then fetchMore()
end sub

sub onListSelected()
    if m.list = invalid then return
    i = m.listNode.itemSelected
    if i < 0 or i >= m.list.items.Count() then return
    it = m.list.items[i]
    if it.seriesId <> invalid and it.play = invalid then
        ' A show opens into its episodes; Back returns to the shows.
        saved = { list: m.list, index: i }
        loadList("show:" + it.seriesId.ToStr(), "episodes", "/api/tv/vod", { source: m.pl.source, kind: "series", seriesId: it.seriesId }, it.name)
        m.listReturn = saved
        return
    end if
    if it.play <> invalid then playIndex(i)
end sub

sub restoreList(saved as object)
    m.list = saved.list
    m.listReturn = invalid
    m.listNode.content = CreateObject("roSGNode", "ContentNode")
    items = m.list.items
    m.list.items = []
    addItems(items)
    m.listHead.text = m.list.title + " · " + m.list.total.ToStr()
    m.listNode.jumpToItem = saved.index
    m.listNode.setFocus(true)
end sub

' ---------------------------------------------------------------- playing

function isLive() as boolean
    return m.list <> invalid and m.list.kind = "channels"
end function

sub playIndex(i as integer)
    it = m.list.items[i]
    m.playing = { index: i, item: it, fellBack: false, live: isLive() }
    startVideo(it.play.url, it.play.format, it.name)
    showBanner(it)
end sub

sub startVideo(url as string, format as string, title as string)
    c = CreateObject("roSGNode", "ContentNode")
    c.url = absUrl(url)
    c.streamFormat = format
    c.title = title
    c.live = m.playing.live
    ' Our own /hls/ and /p/ paths need the media cookie (a Roku has no cookie jar for video).
    if Left(url, 1) = "/" and m.media <> invalid then c.HttpHeaders = ["Cookie:" + m.media]
    m.video.content = c
    m.video.visible = true
    m.video.setFocus(true)
    m.video.control = "play"
end sub

sub onVideoState()
    if m.playing = invalid then return
    s = m.video.state
    if s = "error" then
        it = m.playing.item
        if not m.playing.fellBack and it.play.fallback <> invalid then
            ' The Roku would not decode it directly: through hdtilt's HLS remux instead.
            m.playing.fellBack = true
            startVideo(it.play.fallback, "hls", it.name)
            return
        end if
        msg = m.video.errorMsg
        stopVideo()
        m.listHead.text = "Could not play " + it.name + ": " + msg
    else if s = "finished" and not m.playing.live then
        stopVideo()
    end if
end sub

sub stopVideo()
    if m.video = invalid then return
    m.video.control = "stop"
    m.video.visible = false
    m.banner.visible = false
    if m.playing <> invalid and m.browse.visible then
        m.listNode.jumpToItem = m.playing.index
        m.listNode.setFocus(true)
    end if
    m.playing = invalid
end sub

sub zap(delta as integer)
    if m.playing = invalid or not m.playing.live or m.list = invalid then return
    n = m.list.items.Count()
    if n = 0 then return
    i = m.playing.index + delta
    if i < 0 then i = n - 1
    if i >= n then
        fetchMore()
        if m.list.total > n then return
        i = 0
    end if
    m.video.control = "stop"
    playIndex(i)
end sub

sub showBanner(it as object)
    m.top.findNode("bannerName").text = it.name
    m.top.findNode("bannerNum").text = subLine(it)
    sub2 = ""
    if m.list <> invalid then sub2 = m.list.title
    if m.playing.live then sub2 = sub2 + "   ▲▼ change channel"
    m.top.findNode("bannerSub").text = sub2
    logo = ""
    if type(it.logo) = "roString" or type(it.logo) = "String" then logo = it.logo
    m.top.findNode("bannerLogo").uri = logo
    m.banner.visible = true
    m.bannerTimer.control = "stop"
    m.bannerTimer.control = "start"
end sub

sub onBannerTimer()
    m.banner.visible = false
end sub

' ---------------------------------------------------------------- dialogs

sub askSearch(title as string, kind as string)
    d = CreateObject("roSGNode", "StandardKeyboardDialog")
    d.title = title
    d.buttons = ["Search", "Cancel"]
    d.observeField("buttonSelected", "onSearchButton")
    m.searchKind = kind
    m.top.dialog = d
end sub

sub onSearchButton()
    d = m.top.dialog
    if d = invalid then return
    q = d.text
    pressed = d.buttonSelected
    d.close = true
    if pressed <> 0 or q = invalid or q.Trim() = "" then return
    q = q.Trim()
    if m.searchKind = "channels" then
        loadList("search:" + q, "channels", "/api/tv/channels", { source: m.pl.source, q: q }, "Search: " + q)
    else
        loadList("vsearch:" + q, "titles", "/api/tv/vod", { source: m.pl.source, kind: m.vodKind, q: q }, m.vodLabel + ": " + q)
    end if
    m.listNode.setFocus(true)
end sub

sub showOptions()
    d = CreateObject("roSGNode", "StandardMessageDialog")
    d.title = "hdtilt"
    lines = []
    if m.pl <> invalid then lines.push("Playlist: " + m.pl.name)
    lines.push("Manage playlists and favorites at hdtilt.com.")
    d.message = lines
    m.optionActions = []
    buttons = []
    if m.playlists <> invalid and m.playlists.Count() > 1 then
        buttons.push("Switch playlist")
        m.optionActions.push("switch")
    end if
    buttons.push("Reload")
    m.optionActions.push("reload")
    buttons.push("Sign out")
    m.optionActions.push("signout")
    buttons.push("Close")
    m.optionActions.push("close")
    d.buttons = buttons
    d.observeField("buttonSelected", "onOptionsButton")
    m.top.dialog = d
end sub

sub onOptionsButton()
    d = m.top.dialog
    if d = invalid then return
    a = m.optionActions[d.buttonSelected]
    d.close = true
    if a = "switch" then
        showPlaylists()
    else if a = "reload" then
        m.list = invalid
        loadLibrary()
    else if a = "signout" then
        signOut()
    end if
end sub

sub showPlaylists()
    d = CreateObject("roSGNode", "StandardMessageDialog")
    d.title = "Switch playlist"
    d.message = ["Which playlist should hdtilt open?"]
    names = []
    for each p in m.playlists
        names.push(p.name)
    end for
    d.buttons = names
    d.observeField("buttonSelected", "onPlaylistButton")
    m.top.dialog = d
end sub

sub onPlaylistButton()
    d = m.top.dialog
    if d = invalid then return
    p = m.playlists[d.buttonSelected]
    d.close = true
    if p = invalid then return
    regWrite("playlist", p.id)
    m.list = invalid
    openPlaylist(p)
end sub

sub signOut()
    rt = regRead("refresh")
    if rt <> invalid then api({ method: "POST", path: "/oauth/revoke", form: { token: rt } }, "revoke")
    m.list = invalid
    m.pl = invalid
    regDelete("playlist")
    startLink()
end sub

' ---------------------------------------------------------------- keys

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.video.visible then
        if key = "back" then
            stopVideo()
            return true
        end if
        if key = "up" or key = "channelUp" then
            zap(-1)
            return true
        end if
        if key = "down" or key = "channelDown" then
            zap(1)
            return true
        end if
        if key = "OK" and m.playing <> invalid then
            showBanner(m.playing.item)
            return false
        end if
        return false
    end if
    if m.message.visible then
        if key = "OK" then
            if m.retry = "library" then
                loadLibrary()
            else if m.retry = "load" and m.pl <> invalid then
                openPlaylist(m.pl)
            end if
            return true
        end if
        if key = "options" and m.pl <> invalid then
            showOptions()
            return true
        end if
        return false
    end if
    if m.linkGroup.visible then
        if key = "OK" and m.retry = "link" then
            startLink()
            return true
        end if
        return false
    end if
    if m.browse.visible then
        if key = "options" then
            showOptions()
            return true
        end if
        if m.listNode.hasFocus() then
            if key = "left" or key = "back" then
                if key = "back" and m.listReturn <> invalid then
                    restoreList(m.listReturn)
                else
                    m.rail.setFocus(true)
                end if
                return true
            end if
        else if m.rail.hasFocus() then
            if key = "right" then
                if m.listNode.content <> invalid and m.listNode.content.getChildCount() > 0 then m.listNode.setFocus(true)
                return true
            end if
            if key = "back" and m.railMode = "vod" then
                buildMainRail()
                m.list = invalid
                openRailEntry(0, false)
                return true
            end if
        end if
    end if
    return false
end function
