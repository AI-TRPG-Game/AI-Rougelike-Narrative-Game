' ============================================================
'  One-click stop: kills the game server (the node.exe process
'  whose command line contains "server.ts"). Other node
'  programs are NOT touched. Safe to run at any time - if the
'  game is not running, nothing happens.
' ============================================================
Option Explicit

Dim sh, wmi, procs, p, cl, killed
Set sh  = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

killed = 0
Set procs = wmi.ExecQuery( _
  "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")

For Each p In procs
  cl = ""
  If Not IsNull(p.CommandLine) Then cl = LCase(p.CommandLine)
  If InStr(cl, "server.ts") > 0 Then
    ' /T = also kill its child processes; the console window
    ' that hosts it closes together with the process.
    sh.Run "taskkill /PID " & p.ProcessId & " /F /T", 0, True
    killed = killed + 1
  End If
Next

' brief feedback for the player (auto-closes)
If killed = 0 Then
  sh.Popup "The game is not running.", 2, "Close Game", 64
Else
  sh.Popup "Game server stopped (" & killed & ").", 2, "Close Game", 64
End If
