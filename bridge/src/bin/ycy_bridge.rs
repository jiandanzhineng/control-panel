use brand_bridge::{run, Brand};
use std::process;

fn parse_port() -> u16 {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "-port" {
            if let Some(p) = args.next().and_then(|v| v.parse::<u16>().ok()) {
                return p;
            }
        }
    }
    3001
}

#[tokio::main]
async fn main() {
    let port = parse_port();
    if let Err(e) = run(Brand::Ycy, port).await {
        eprintln!("ycy_bridge error: {:?}", e);
        process::exit(1);
    }
}
