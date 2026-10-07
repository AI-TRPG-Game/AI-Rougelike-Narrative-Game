' ============================================================
'  One-click launcher: kills any PREVIOUS game server first
'  (stale instances cause weird bugs - a fresh start every
'  time), then starts the game (--live by default, i.e. the
'  REAL game with the real LLM) in a new minimized console
'  window, and opens the browser.
'
'  The server window stays open (minimized) so you can read
'  errors; closing it - or double-clicking Close Game.vbs -
'  stops the game.
'
'  Requirements: Node.js 22.18+ installed, game/.env filled in
'  (see README.md). No build step needed.
' ============================================================
Option Explicit

Dim sh, fso, wmi, procs, p, cl, gameDir, node, port, url
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

gameDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = gameDir

port = 5188
url  = "http://127.0.0.1:" & port & "/"

' ---- locate node.exe: install dir first, then scan PATH ----
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then
  node = ""
  Dim dirs, d
  dirs = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For Each d In dirs
    If d <> "" Then
      If fso.FileExists(d & "\node.exe") Then
        node = d & "\node.exe"
        Exit For
      End If
    End If
  Next
End If
If node = "" Then
  ' No Node.js anywhere -> say so plainly instead of an obscure script error
  sh.Popup "Node.js not found on this computer." & vbCrLf & vbCrLf & _
           "Please install Node.js 22.18 or newer from https://nodejs.org/ ," & vbCrLf & _
           "then double-click this file again.", 0, "Missing Node.js", 48
  WScript.Quit
End If

' ---- step 1: kill any previous game server ----
' Match by command line ("server.ts"), never by name alone:
' other node programs must not be touched.
Set procs = wmi.ExecQuery( _
  "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In procs
  cl = ""
  If Not IsNull(p.CommandLine) Then cl = LCase(p.CommandLine)
  If InStr(cl, "server.ts") > 0 Then
    sh.Run "taskkill /PID " & p.ProcessId & " /F /T", 0, True
  End If
Next

' ---- step 2: let Windows release the port ----
WScript.Sleep 800

' ---- step 3: start a FRESH server in a new minimized console ----
sh.Run """" & node & """ game\src\ui\server.ts --live --port " & port, 6, False

' ---- step 4: give the server a moment, then open the browser ----
WScript.Sleep 3000
sh.Run url, 1, False
