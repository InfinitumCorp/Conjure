"""Unpack the artifacts fetch-deps.sh downloaded and checked.  usage: extract-deps.py DEPS_DIR
  DEPS_DIR/jars/<name>.jar    classes (an AAR's classes.jar, or the jar itself)
  DEPS_DIR/res/<name>/        an AAR's Android resources, when it has any
  DEPS_DIR/packages.txt       the Java packages of those AARs (aapt2 --extra-packages, for their R classes)
  DEPS_DIR/services/META-INF/services/*   ServiceLoader files from the jars (merged)
Jars rather than loose .class files: nested class paths can pass Windows' 260-character limit."""
import io, os, re, sys, zipfile
d = sys.argv[1]
dl = os.path.join(d, "dl")
os.makedirs(os.path.join(d, "jars"), exist_ok=True)
packages, services = [], {}

def collect_services(z):
    for n in z.namelist():
        if n.startswith("META-INF/services/") and not n.endswith("/"):
            services.setdefault(n, []).append(z.read(n).decode("utf-8").strip())

for f in sorted(os.listdir(dl)):
    name, ext = os.path.splitext(f)
    src = zipfile.ZipFile(os.path.join(dl, f))
    if ext == ".jar":
        data = open(os.path.join(dl, f), "rb").read()
    else:
        data = src.read("classes.jar")
        res = [n for n in src.namelist() if n.startswith("res/") and not n.endswith("/")]
        if res:
            for n in res:
                out = os.path.join(d, "res", name, n[len("res/"):])
                os.makedirs(os.path.dirname(out), exist_ok=True)
                open(out, "wb").write(src.read(n))
            m = re.search(rb'package="([^"]+)"', src.read("AndroidManifest.xml"))
            packages.append(m.group(1).decode())
    open(os.path.join(d, "jars", name + ".jar"), "wb").write(data)
    collect_services(zipfile.ZipFile(io.BytesIO(data)))

open(os.path.join(d, "packages.txt"), "w").write(":".join(packages))
for n, parts in services.items():
    out = os.path.join(d, "services", n)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", newline="\n").write("\n".join(parts) + "\n")
