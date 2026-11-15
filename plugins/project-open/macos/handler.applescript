on open location folderURL
  set helperPath to POSIX path of (path to resource "open_folder.py")
  do shell script "/usr/bin/python3 " & quoted form of helperPath & " --url " & quoted form of folderURL & " >/dev/null 2>&1 &"
end open location
