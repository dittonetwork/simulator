How to start in workspace dir:

`docker compose up -d sandbox`

`cargo build --release --target wasm32-wasip1`

`WASM_SERVER_URL=http://localhost:8080/wasm bun run examples/wasm/run-wasm.ts --wasm ./examples/wasm/sum/target/wasm32-wasip1/release/sum.wasm --input '{"a": 100, "b": 200}'`
