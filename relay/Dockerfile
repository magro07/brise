# brise-relay – kleines, statisch gelinktes Image ohne Shell.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked && strip target/release/brise-relay

FROM scratch
COPY --from=build /src/target/release/brise-relay /brise-relay
ENV BRISE_RELAY_ADDR=0.0.0.0:8787
EXPOSE 8787
USER 65534:65534
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/brise-relay", "--healthcheck"]
ENTRYPOINT ["/brise-relay"]
