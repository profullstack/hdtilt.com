sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    used = regRead("access")
    res = doRequest(req)
    if res.status = 401 and req.auth = true then
        ' Another request may have refreshed already; otherwise refresh here.
        now = regRead("access")
        if now <> invalid and (used = invalid or now <> used) then
            res = doRequest(req)
        else if refreshTokens() then
            res = doRequest(req)
        else
            res.error = "signin"
        end if
    end if
    m.top.response = res
end sub

function formEncode(xfer as object, form as object) as string
    parts = []
    for each k in form
        parts.push(xfer.Escape(k) + "=" + xfer.Escape(form[k]))
    end for
    return parts.Join("&")
end function

function doRequest(req as object) as object
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.RetainBodyOnError(true)
    xfer.EnableEncodings(true)
    xfer.SetUrl(hdBase() + req.path)
    xfer.AddHeader("Accept", "application/json")
    if req.auth = true then
        at = regRead("access")
        if at <> invalid then xfer.AddHeader("Authorization", "Bearer " + at)
    end if
    method = "GET"
    if req.method <> invalid then method = req.method
    ok = false
    if method = "GET" then
        ok = xfer.AsyncGetToString()
    else
        body = ""
        if req.form <> invalid then
            xfer.AddHeader("Content-Type", "application/x-www-form-urlencoded")
            body = formEncode(xfer, req.form)
        else
            xfer.AddHeader("Content-Type", "application/json")
            if req.body <> invalid then body = FormatJson(req.body)
        end if
        xfer.SetRequest(method)
        ok = xfer.AsyncPostFromString(body)
    end if
    if not ok then return { status: 0, data: invalid, error: "network", code: "" }
    msg = wait(60000, port)
    if type(msg) <> "roUrlEvent" then
        xfer.AsyncCancel()
        return { status: 0, data: invalid, error: "The server took too long to answer.", code: "" }
    end if
    code = msg.GetResponseCode()
    text = msg.GetString()
    data = invalid
    if text <> invalid and text <> "" then data = ParseJson(text)
    res = { status: code, data: data, error: "", code: "" }
    if code < 200 or code >= 300 then
        res.error = "The server answered " + code.ToStr() + "."
        if code < 0 then res.error = "Network error: " + msg.GetFailureReason()
        if type(data) = "roAssociativeArray" then
            if type(data.error) = "roString" or type(data.error) = "String" then res.error = data.error
            if data.code <> invalid then res.code = data.code
        end if
    end if
    return res
end function

' Trade the refresh token for a new pair. False when the TV must sign in again.
function refreshTokens() as boolean
    rt = regRead("refresh")
    if rt = invalid then return false
    res = doRequest({ method: "POST", path: "/oauth/token", form: { grant_type: "refresh_token", refresh_token: rt, client_id: "hdtilt-tv" } })
    if res.status = 200 and type(res.data) = "roAssociativeArray" and res.data.access_token <> invalid then
        regWrite("access", res.data.access_token)
        if res.data.refresh_token <> invalid then regWrite("refresh", res.data.refresh_token)
        return true
    end if
    if res.status = 400 or res.status = 401 then
        ' A refresh token another request already rotated is not a sign-out.
        if regRead("refresh") <> invalid and regRead("refresh") <> rt then return true
        regDelete("access")
        regDelete("refresh")
    end if
    return false
end function
