//! Shared Zod contracts are exported at build time; validation stays entirely in Rust.
use crate::util::Result;
use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

pub fn validate(contract: &str, value: &Value) -> Result<()> {
    static VALIDATORS: OnceLock<HashMap<String, jsonschema::Validator>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        let contracts: HashMap<String, Value> =
            serde_json::from_str(include_str!("../resources/contracts.json"))
                .expect("invalid bundled contracts");
        contracts
            .into_iter()
            .map(|(name, schema)| {
                let validator = jsonschema::options()
                    .should_validate_formats(true)
                    .build(&schema)
                    .expect("invalid bundled contract");
                (name, validator)
            })
            .collect()
    });
    let validator = validators.get(contract).ok_or("本机数据校验类型不正确")?;
    if validator.is_valid(value) {
        Ok(())
    } else {
        Err(format!("本机记录格式不兼容（{contract}），原文件已保留"))
    }
}
