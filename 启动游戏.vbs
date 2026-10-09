' ============================================================
'  One-click launcher: kills any PREVIOUS game server first
'  (stale instances cause weird bugs - a fresh start every
'  time), then starts the game (--live by default, i.e. the
'  REAL game with the real LLM) in a new minimized console
'  window, and opens the browser.
'
'  The server window stays open (minimized) so you can read
'  errors; closing it - or double-clicking 关闭游戏.vbs -
'  stops the game.
'
'  Requirements: Node.js 22.18+ installed, game/.env filled in
'  (see README.md). No build step needed.
'
'  2026-10-09: fail LOUDLY, never silently. A player who cloned
'  the repo used to hit invisible failures: the server refuses
'  to start when game\.env is missing or the key is still the
'  placeholder, and that error only ever appeared in the
'  minimized console - a window that dies with the process, so
'  the player saw a browser page that never loads and no reason
'  why. Now every common failure gets a popup that says exactly
'  what to fix:
'    1. Node.js missing                   -> install Node.js 22.18+
'    2. game\.env missing                 -> copy .env.example, rename to .env
'    3. API config invalid               -> configure the selected provider
'    4. server exits within 3s            -> survive-check popup (bad .env,
'       (port in use, Node too old, ...)     port already used, Node < 22.18...)
'                                            plus the command that shows the
'                                            real error
'
'  2026-10-09 (later the same day): inline '#' comments in .env values are
'  now stripped automatically by llm/config.ts · parseEnv - a model name can
'  never legitimately contain '#' (user ruling), so
'  `DEEPSEEK_MODEL=deepseek-flash ##注释` just works, no popup, no player
'  action. The launcher's old '#' check was removed accordingly.
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

' All player-facing popups go through this one sub - the launcher stays
' readable, and the smoke test can swap this single line for an echo to
' verify every failure path without clicking anything.
Sub Say(msg, title, icon)
  sh.Popup msg, 0, title, icon
End Sub

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
  Say "Node.js not found on this computer." & vbCrLf & vbCrLf & _
      "Please install Node.js 22.18 or newer from https://nodejs.org/ ," & vbCrLf & _
      "then double-click this file again.", "Missing Node.js", 48
  WScript.Quit
End If

' ---- check game\.env BEFORE touching anything else ----
' server.ts (llm/config.ts · loadConfig) refuses to start when .env is
' missing or the key is still the placeholder, and that error only ever
' showed in the minimized console - i.e. invisible to the player. Mirror
' the same checks here so the player gets told what to fix.
Dim envPath, configStatus
envPath = gameDir & "\game\.env"

If Not fso.FileExists(envPath) Then
  Say "game\.env was not found." & vbCrLf & vbCrLf & _
      "This file is NOT in the repository - every player creates their own:" & vbCrLf & vbCrLf & _
      "  1. copy  game\.env.example" & vbCrLf & _
      "  2. rename the copy to  game\.env" & vbCrLf & _
      "  3. select DeepSeek or SoCLaaS and fill in its API Key (see README.md)" & vbCrLf & vbCrLf & _
      "Then double-click this launcher again.", "Missing game\.env", 48
  WScript.Quit
End If

' Use the server configuration loader instead of duplicating .env parsing.
' Hidden, synchronous, and offline: no server starts and no API is called.
configStatus = sh.Run("""" & node & """ game\src\llm\check-config.ts", 0, True)
If configStatus <> 0 Then
  Say "The selected API configuration in game\.env could not be loaded." & vbCrLf & vbCrLf & _
      "  LLM_PROVIDER=soclaas  uses SOCLAAS_API_KEY" & vbCrLf & _
      "  LLM_PROVIDER=deepseek uses DEEPSEEK_API_KEY" & vbCrLf & vbCrLf & _
      "Fill in the selected provider's real key, not a placeholder." & vbCrLf & _
      "SoCLaaS does not need a DeepSeek key." & vbCrLf & vbCrLf & _
      "To see the exact error, open a terminal in this folder and run:" & vbCrLf & _
      "  node game\src\llm\check-config.ts" & vbCrLf & _
      "Node.js 22.18 or newer is required." & vbCrLf & vbCrLf & _
      "Then double-click this launcher again.", "API key not set", 48
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

' ---- step 4: make sure it SURVIVED, then open the browser ----
' Config failures and listen failures (port already in use) kill the
' process within the first second - and the minimized console dies with
' it, so the error message is lost. A 3s survive-check catches every such
' crash and replaces the silent blank browser page with a popup that
' tells the player how to see the real error. A slow machine is fine:
' the process exists from the moment sh.Run creates it - only a dead
' process means failure.
WScript.Sleep 3000
Dim alive
alive = False
Set procs = wmi.ExecQuery( _
  "SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In procs
  cl = ""
  If Not IsNull(p.CommandLine) Then cl = LCase(p.CommandLine)
  If InStr(cl, "server.ts") > 0 Then alive = True
Next

If Not alive Then
  Say "The game server did not start - it exited right away, and its error" & vbCrLf & _
      "message disappeared together with the console window." & vbCrLf & vbCrLf & _
      "Common causes:" & vbCrLf & _
      "  - game\.env has invalid content" & vbCrLf & _
      "  - port " & port & " is already used by another program" & vbCrLf & _
      "  - Node.js is older than 22.18" & vbCrLf & vbCrLf & _
      "To see the real error, open a command prompt in this folder and run:" & vbCrLf & _
      "  node game\src\ui\server.ts --live --port " & port, "Game failed to start", 16
  WScript.Quit
End If

sh.Run url, 1, False
