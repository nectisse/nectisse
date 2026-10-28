on run argv
	set mountFolder to (POSIX file (item 1 of argv)) as alias
	set backgroundFile to (POSIX file (item 2 of argv)) as alias
	set originX to (item 3 of argv) as integer
	set originY to (item 4 of argv) as integer
	set windowWidth to (item 5 of argv) as integer
	set windowHeight to (item 6 of argv) as integer
	set appX to (item 7 of argv) as integer
	set appY to (item 8 of argv) as integer
	set applicationsX to (item 9 of argv) as integer
	set applicationsY to (item 10 of argv) as integer

	tell application "Finder"
		tell folder mountFolder
			open
			tell container window
				set current view to icon view
				set toolbar visible to false
				set statusbar visible to false
				set bounds to {originX, originY, originX + windowWidth, originY + windowHeight}
			end tell
			set options to icon view options of container window
			set arrangement of options to not arranged
			set icon size of options to 112
			set text size of options to 13
			set background picture of options to backgroundFile
			set position of item "Nectisse.app" to {appX, appY}
			set extension hidden of item "Nectisse.app" to true
			set position of item "Applications" to {applicationsX, applicationsY}
			update without registering applications
			close
			open
			delay 2
			set actualBounds to bounds of container window
			set actualApp to position of item "Nectisse.app"
			set actualApplications to position of item "Applications"
			close
		end tell
	end tell
	delay 2
	return (actualBounds as list) & (actualApp as list) & (actualApplications as list)
end run
