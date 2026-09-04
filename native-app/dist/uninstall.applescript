-- Uninstaller for Deck RX Solo, compiled into an app by notarize.sh --dmg.
--
-- An AppleScript applet rather than a .command file: osacompile produces a real
-- bundle with a Mach-O stub, which can be signed and notarised along with
-- everything else in the disk image. A loose shell script cannot be, and a
-- downloaded one meets Gatekeeper on its own terms.
--
-- It removes only what this app put there, names all of it before touching
-- anything, and asks a second time before the settings.

on run
	set appPath to "/Applications/Deck RX Solo.app"
	set supportPath to (POSIX path of (path to home folder)) & "Library/Application Support/deck-rx"

	set installed to false
	try
		do shell script "test -d " & quoted form of appPath
		set installed to true
	end try

	if not installed then
		display dialog "Deck RX Solo は /Applications にありません。" & return & return & ¬
			"すでに削除されているか、別の場所にあります。" ¬
			buttons {"OK"} default button 1 with title "Deck RX Solo アンインストール"
		return
	end if

	set answer to display dialog "Deck RX Solo を削除します。" & return & return & ¬
		"消すもの:" & return & ¬
		"  • " & appPath & return & ¬
		"  • 環境設定 (com.hogehoge.deckrx.solo.plist)" & return & ¬
		"  • キャッシュとウインドウ状態" & return & return & ¬
		"受信設定と局リストは、このあと別に確認します。" ¬
		buttons {"キャンセル", "削除"} default button "キャンセル" ¬
		with title "Deck RX Solo アンインストール" with icon caution
	if button returned of answer is "キャンセル" then return

	-- Quit it first, matched on the bundle path: both bundles run an executable
	-- called deck-rx-receiver, so the process name alone would take the
	-- front-end down with it.
	try
		do shell script "pkill -f 'Deck RX Solo.app/Contents/MacOS' || true"
		delay 1
	end try

	set removed to {}
	set failed to false

	try
		do shell script "rm -rf " & quoted form of appPath
		set end of removed to appPath
	on error
		-- Owned by another user, or /Applications is not writable by this one.
		try
			do shell script "rm -rf " & quoted form of appPath with administrator privileges
			set end of removed to appPath
		on error
			set failed to true
		end try
	end try

	set home to POSIX path of (path to home folder)
	repeat with p in {home & "Library/Preferences/com.hogehoge.deckrx.solo.plist", ¬
		home & "Library/Caches/com.hogehoge.deckrx.solo", ¬
		home & "Library/Saved Application State/com.hogehoge.deckrx.solo.savedState", ¬
		home & "Library/HTTPStorages/com.hogehoge.deckrx.solo"}
		try
			do shell script "test -e " & quoted form of (p as text) & " && rm -rf " & quoted form of (p as text)
			set end of removed to (p as text)
		end try
	end repeat

	-- The settings are shared with the front-end bundle, so they are a separate
	-- question and the answer defaults to keeping them.
	set keepSettings to true
	try
		do shell script "test -d " & quoted form of supportPath
		set a2 to display dialog "受信設定・プリセット・局データベースも削除しますか？" & return & return & ¬
			supportPath & return & return & ¬
			"これは Deck RX (front-end) とも共有しています。残しておけば、" & ¬
			"入れ直したときに設定がそのまま戻ります。" ¬
			buttons {"残す", "削除する"} default button "残す" ¬
			with title "Deck RX Solo アンインストール"
		if button returned of a2 is "削除する" then
			do shell script "rm -rf " & quoted form of supportPath
			set end of removed to supportPath
			set keepSettings to false
		end if
	end try

	set msg to "削除しました:" & return
	repeat with r in removed
		set msg to msg & "  • " & (r as text) & return
	end repeat
	if keepSettings then
		set msg to msg & return & "設定は残してあります。"
	end if
	set msg to msg & return & return & ¬
		"「ローカルネットワーク」の許可だけは、ここからは消せません。" & ¬
		"不要なら システム設定 > プライバシーとセキュリティ > ローカルネットワーク で外してください。"
	if failed then
		set msg to msg & return & return & "※ アプリ本体を削除できませんでした。手動で捨ててください。"
	end if

	display dialog msg buttons {"OK"} default button 1 with title "Deck RX Solo アンインストール"
end run
