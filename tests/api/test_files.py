from tests.api.conftest import PDF, PNG


def upload(env, name="pic.png", data=PNG, **form):
    return env.client.post("/api/admin/files", files={"file": (name, data)}, data=form)


def test_upload_defaults_private(admin):
    r = upload(admin)
    assert r.status_code == 201, r.text
    item = r.json()["data"]
    assert item["visibility"] == "private" and item["status"] == "published" and item["exposed"] is False
    assert item["kind"] == "image" and item["name"] == "pic.png" and item["size"] == len(PNG)
    assert len(admin.stored_files("private")) == 1 and admin.stored_files("public") == []
    # 磁盘文件名是 UUID，不含原文件名
    assert "pic" not in admin.stored_files("private")[0].name
    assert item["src"] == f"/api/admin/files/{item['id']}/content"


def test_public_upload_goes_to_public_dir(admin):
    item = upload(admin, visibility="public").json()["data"]
    assert item["exposed"] is True and item["src"].startswith("/uploads/public/")
    assert len(admin.stored_files("public")) == 1 and admin.stored_files("private") == []
    assert item["src"].endswith(admin.stored_files("public")[0].name)


def test_public_draft_stays_private(admin):
    item = upload(admin, visibility="public", status="draft").json()["data"]
    assert item["exposed"] is False
    assert len(admin.stored_files("private")) == 1


def test_visitors_see_only_exposed_files(admin):
    pub = upload(admin, name="a.png", visibility="public").json()["data"]
    priv = upload(admin, name="b.png").json()["data"]
    admin.logout()
    listed = admin.client.get("/api/public/files").json()["data"]
    assert [f["id"] for f in listed] == [pub["id"]]
    assert set(listed[0]) == {"id", "name", "ext", "kind", "size", "updatedAt", "src", "description"}
    assert admin.client.get(f"/api/public/files/{pub['id']}").status_code == 200
    assert admin.client.get(f"/api/public/files/{priv['id']}").status_code == 404


def test_private_content_requires_login(admin):
    item = upload(admin).json()["data"]
    r = admin.client.get(item["src"])
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    assert "inline" in r.headers["content-disposition"]
    dl = admin.client.get(item["src"], params={"download": "true"})
    assert "attachment" in dl.headers["content-disposition"]
    admin.logout()
    assert admin.client.get(item["src"]).status_code == 401


def test_switching_visibility_moves_file(admin):
    item = upload(admin).json()["data"]
    r = admin.client.patch(f"/api/admin/files/{item['id']}", json={"visibility": "public"})
    assert r.json()["data"]["exposed"] is True
    assert len(admin.stored_files("public")) == 1 and admin.stored_files("private") == []
    r = admin.client.patch(f"/api/admin/files/{item['id']}", json={"status": "draft"})
    assert r.json()["data"]["exposed"] is False
    assert admin.stored_files("public") == [] and len(admin.stored_files("private")) == 1
    admin.logout()
    assert admin.client.get("/api/public/files").json()["data"] == []


def test_rename_and_description_do_not_touch_disk(admin):
    item = upload(admin).json()["data"]
    before = admin.stored_files("private")
    r = admin.client.patch(f"/api/admin/files/{item['id']}", json={"name": "new.png", "description": "d"})
    assert r.json()["data"]["name"] == "new.png" and r.json()["data"]["description"] == "d"
    assert admin.stored_files("private") == before


def test_delete_removes_file_and_row(admin):
    item = upload(admin, visibility="public").json()["data"]
    assert admin.client.delete(f"/api/admin/files/{item['id']}").status_code == 200
    assert admin.stored_files("public") == []
    assert admin.client.get(f"/api/admin/files/{item['id']}").status_code == 404


def test_rejects_disallowed_types(admin):
    for name, data in [
        ("x.html", b"<script>alert(1)</script>"),
        ("x.svg", b"<svg onload=alert(1)></svg>"),
        ("x.js", b"alert(1)"),
        ("x.exe", b"MZ\x90\x00"),
        ("noext", b"hello"),
        ("trailingdot.", b"hello"),
        (".hidden", b"hello"),
        ("long.verylongextension", b"hello"),
        ("中文.文件", b"hello"),
    ]:
        r = upload(admin, name=name, data=data)
        assert r.status_code == 415, name
        assert r.json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    assert admin.stored_files("private") == [] and admin.stored_files("public") == []


def test_no_extension_is_415_not_500(admin):
    """回归：无扩展名文件曾在拼磁盘路径时抛 ValueError，变成 500。"""
    r = upload(admin, name="noext", data=PNG)
    assert r.status_code == 415
    body = r.json()
    assert body["success"] is False and body["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    assert admin.stored_files("private") == [] and admin.stored_files("public") == []
    leftovers = [p.name for d in ("private", "public") for p in (admin.uploads / d).iterdir()]
    assert leftovers == []  # 连 .part 临时文件也没有


def test_rejects_content_extension_mismatch(admin):
    r = upload(admin, name="fake.png", data=b"<html>not a png</html>")
    assert r.status_code == 415
    r = upload(admin, name="fake.pdf", data=PNG)
    assert r.status_code == 415
    assert admin.stored_files("private") == []


def test_rejects_empty_and_oversize(admin):
    assert upload(admin, name="e.txt", data=b"").status_code == 422
    big = upload(admin, name="big.txt", data=b"a" * (1024 * 1024 + 1))  # MAX_UPLOAD_MB=1
    assert big.status_code == 413 and big.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert admin.stored_files("private") == []
    # 临时文件也不应残留
    assert not any(p.name.endswith(".part") for p in (admin.uploads / "private").iterdir())


def test_path_traversal_in_filename_is_neutralised(admin):
    item = upload(admin, name="../../etc/passwd.txt", data=b"hello").json()["data"]
    assert "/" not in item["name"] and ".." not in item["name"]
    stored = admin.stored_files("private")[0]
    assert stored.parent == admin.uploads / "private"


def test_explicit_id_and_conflicts(admin):
    assert upload(admin, id="my-file").json()["data"]["id"] == "my-file"
    r = upload(admin, id="my-file")
    assert r.status_code == 409 and len(admin.stored_files("private")) == 1
    assert upload(admin, id="Bad ID").status_code == 422


def test_auto_id_deduplicates(admin):
    a = upload(admin, name="report.pdf", data=PDF).json()["data"]
    b = upload(admin, name="report.pdf", data=PDF).json()["data"]
    assert a["id"] != b["id"]
    assert len(admin.stored_files("private")) == 2


def test_chinese_filename_kept_in_db_only(admin):
    item = upload(admin, name="学习笔记.pdf", data=PDF).json()["data"]
    assert item["name"] == "学习笔记.pdf" and item["ext"] == "pdf" and item["kind"] == "pdf"
    assert item["id"]  # slug 生成不失败（无 pypinyin 时回退到前缀 + 随机后缀）


def test_serve_public_uploads_toggle(make_env):
    off = make_env()
    off.login()
    item = upload(off, visibility="public").json()["data"]
    assert off.client.get(item["src"]).status_code == 404

    on = make_env(SERVE_PUBLIC_UPLOADS="true")
    on.login()
    item = upload(on, visibility="public").json()["data"]
    r = on.client.get(item["src"])
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["cache-control"] == "no-store"


def test_private_files_never_reachable_via_public_static_mount(make_env):
    e = make_env(SERVE_PUBLIC_UPLOADS="true")
    e.login()
    upload(e)  # private
    name = e.stored_files("private")[0].name
    for url in (f"/uploads/public/{name}", f"/uploads/private/{name}", f"/uploads/public/../private/{name}"):
        assert e.client.get(url).status_code == 404


def test_missing_on_disk_returns_clear_error(admin):
    item = upload(admin).json()["data"]
    admin.stored_files("private")[0].unlink()
    r = admin.client.get(item["src"])
    assert r.status_code == 404 and r.json()["error"]["code"] == "FILE_MISSING"
