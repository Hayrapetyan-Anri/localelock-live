FROM public.ecr.aws/lambda/nodejs:22

ENV UV_INSTALL_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_TOOL_DIR=/opt/uv-tools \
    UV_TOOL_BIN_DIR=/usr/local/bin

RUN dnf install -y tar gzip \
 && dnf clean all \
 && rm -rf /var/cache/dnf \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && uv python install 3.12 \
 && uv tool install mcp-clickhouse==0.6.0 --python 3.12 \
 && test -x /usr/local/bin/mcp-clickhouse

ENV MCP_CLICKHOUSE_BIN=/usr/local/bin/mcp-clickhouse

ENV HOME=/tmp

COPY artifact/ ${LAMBDA_TASK_ROOT}/

CMD ["api.handler"]
