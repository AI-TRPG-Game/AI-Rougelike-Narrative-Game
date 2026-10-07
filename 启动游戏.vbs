' ============================================================
'  One-click launcher: starts the game server (--live by
'  default, i.e. the REAL game with the real LLM), then opens
'  the browser. The server window stays open (minimized) so
'  you can read errors; closing it stops the game.
'
'  Requirements: Node.js 22+ installed, game/.env filled in
'  (see README.md). No build step needed.
' ============================================================
Option Explicit

Dim sh, fso, gameDir, node, port, url
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

gameDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = gameDir

port = 5188
url  = "http://127.0.0.1:" & port & "/"

' ---- locate node.exe: install dir first, then PATH ----
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node.exe"

' ---- start server in a MINIMIZED console window (style 6) ----
' If a server is already running on this port the new one
' simply fails and prints why into its window - harmless.
sh.Run """" & node & """ game\src\ui\server.ts --live --port " & port, 6, False

' ---- give the server a moment, then open the browser ----
WScript.Sleep 3000
sh.Run url, 1, False
