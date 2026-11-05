' Shared by the scene and the HTTP task: the registry (tokens, prefs) and URLs.

function regRead(key as string) as dynamic
    sec = CreateObject("roRegistrySection", "hdtilt")
    if sec.Exists(key) then return sec.Read(key)
    return invalid
end function

sub regWrite(key as string, value as string)
    sec = CreateObject("roRegistrySection", "hdtilt")
    sec.Write(key, value)
    sec.Flush()
end sub

sub regDelete(key as string)
    sec = CreateObject("roRegistrySection", "hdtilt")
    sec.Delete(key)
    sec.Flush()
end sub

' The hdtilt server. A self-hosted one can be set in the registry key "base".
function hdBase() as string
    b = regRead("base")
    if b <> invalid and b <> "" then return b
    return "https://hdtilt.com"
end function

' Server paths (/hls/...) are relative; provider URLs are absolute.
function absUrl(u as string) as string
    if Left(u, 1) = "/" then return hdBase() + u
    return u
end function
