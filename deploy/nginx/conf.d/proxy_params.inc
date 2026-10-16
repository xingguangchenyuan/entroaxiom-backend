# 用 $http_host（含端口）：后端要拿它与浏览器的 Origin 比对
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 60s;
