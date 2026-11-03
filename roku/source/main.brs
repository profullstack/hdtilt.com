' hdtilt for Roku: a thin client of hdtilt.com (see README "Roku").
sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("MainScene")
    screen.show()
    ' Input (ECP /input) arrives while running; nothing deep-links yet.
    input = CreateObject("roInput")
    input.SetMessagePort(port)
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
    end while
end sub
