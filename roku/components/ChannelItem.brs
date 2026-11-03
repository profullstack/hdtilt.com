sub init()
    m.logo = m.top.findNode("logo")
    m.num = m.top.findNode("num")
    m.name = m.top.findNode("name")
end sub

sub showContent()
    c = m.top.itemContent
    if c = invalid then return
    m.name.text = c.title
    m.num.text = c.shortDescriptionLine1
    m.logo.uri = c.HDPosterUrl
end sub

sub showFocus()
    if m.top.focusPercent > 0.5 then
        m.name.color = "#0b0f14"
        m.num.color = "#0b0f14"
    else
        m.name.color = "#e6edf3"
        m.num.color = "#8b98a8"
    end if
end sub

