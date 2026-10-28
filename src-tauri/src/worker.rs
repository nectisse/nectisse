use crate::{
    backend::{Backend, Job},
    platform,
    util::*,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

struct OwnedWorker {
    child: Child,
    pid: i32,
    job: Arc<Job>,
}

impl Drop for OwnedWorker {
    fn drop(&mut self) {
        self.child.stdin.take();
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_millis(300);
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(mut pids) = self.job.pids.lock() {
            pids.retain(|pid| *pid != self.pid);
        }
    }
}

impl Backend {
    pub fn worker(
        &self,
        method: &str,
        params: Value,
        job: &Arc<Job>,
        mut progress: impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        job.running()?;
        let layout = &self.0.python;
        let executable = layout.join("runtime/bin/python3");
        let bootstrap = if self.0.packaged {
            layout.join("app/bootstrap.py")
        } else {
            self.0.root_project.join("python/bootstrap.py")
        };
        #[cfg(test)]
        let bootstrap = self
            .0
            .worker_fixture
            .lock()
            .map_err(|_| "Fixture lock unavailable")?
            .clone()
            .unwrap_or(bootstrap);
        let mut command = Command::new(executable);
        command
            .args(["-I", "-S", "-B", "-u"])
            .arg(bootstrap)
            .arg("--dependencies")
            .arg(layout.join("dependencies"));
        let browser = method == "metadata.query"
            && text(&params, "source") == "fc2ppvdb"
            && text(&params, "transport") == "browser";
        if browser {
            command
                .arg("--browser-session")
                .arg(self.0.root.join("browser-sessions/fc2ppvdb"));
        }
        #[cfg(test)]
        if method.starts_with("diagnostics.") {
            command.arg("--diagnostics");
        }
        command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().map_err(|_| "RUNTIME_START_FAILED")?;
        let mut worker = OwnedWorker {
            pid: child.id() as i32,
            child,
            job: job.clone(),
        };
        job.pids
            .lock()
            .map_err(|_| "采集进程状态不可用")?
            .push(worker.pid);
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"protocol":1,"id":id,"method":method,"params":params});
        let encoded = request.to_string();
        if encoded.len() > 64 * 1024 {
            return Err("工作者请求超出大小限制".into());
        }
        let stdin = worker.child.stdin.as_mut().ok_or("工作者输入不可用")?;
        writeln!(stdin, "{encoded}").map_err(|_| "工作者输入已断开")?;
        let stdout = worker.child.stdout.take().ok_or("工作者输出不可用")?;
        let stderr = worker.child.stderr.take().ok_or("工作者错误通道不可用")?;
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        let (sender, receiver) = mpsc::sync_channel(16);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let read = reader
                    .by_ref()
                    .take(64 * 1024 + 1)
                    .read_until(b'\n', &mut bytes);
                if bytes.is_empty() {
                    break;
                }
                let valid =
                    read.is_ok() && bytes.len() <= 64 * 1024 && bytes.last() == Some(&b'\n');
                if sender
                    .send(if valid {
                        serde_json::from_slice::<Value>(&bytes)
                            .map_err(|_| "RUNTIME_PROTOCOL_ERROR".to_string())
                    } else {
                        Err("RUNTIME_PROTOCOL_ERROR".to_string())
                    })
                    .is_err()
                    || !valid
                {
                    break;
                }
            }
        });
        let deadline = Instant::now()
            + Duration::from_secs(if browser {
                240
            } else if method == "health" {
                20
            } else {
                60
            });
        let mut ready = false;
        let mut requests = 0;
        let mut result = None;
        let operation = (|| {
            loop {
                job.running()?;
                if Instant::now() > deadline {
                    return Err("RUNTIME_TIMEOUT".into());
                }
                match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(event) => {
                        let event = event?;
                        if number(&event, "protocol") != 1 || text(&event, "id") != id {
                            return Err("RUNTIME_PROTOCOL_ERROR".into());
                        }
                        let kind = text(&event, "kind");
                        if !ready && kind != "ready" {
                            return Err("RUNTIME_PROTOCOL_ERROR".into());
                        }
                        match kind {
                            "ready" if !ready => ready = true,
                            "progress" if result.is_none() => {
                                let payload = event["payload"].clone();
                                if text(&payload, "event") == "request" {
                                    let source = text(&payload, "source");
                                    let host = text(&payload, "host");
                                    let sequence = number(&payload, "sequence");
                                    let expected = if method == "magnet.search" {
                                        params
                                            .get("source")
                                            .and_then(Value::as_str)
                                            .unwrap_or("sukebei")
                                    } else {
                                        params
                                            .get("source")
                                            .or_else(|| params.get("provider"))
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                    };
                                    requests += 1;
                                    let allowed = if expected == "sukebei" {
                                        host == "sukebei.nyaa.si"
                                    } else {
                                        platform::allowed_url(
                                            expected,
                                            &format!("https://{host}/"),
                                            "request",
                                        )
                                    };
                                    if source != expected
                                        || sequence != requests
                                        || requests > if browser { 16 } else { 8 }
                                        || !allowed
                                    {
                                        return Err("来源请求超出许可范围".into());
                                    }
                                    self.permit(source, job)?;
                                    job.running()?;
                                    let permit = json!({"protocol":1,"id":id,"method":"permit","sequence":sequence});
                                    writeln!(
                                        worker.child.stdin.as_mut().ok_or("工作者输入已关闭")?,
                                        "{permit}"
                                    )
                                    .map_err(|_| "工作者输入已断开")?;
                                }
                                progress(payload)?;
                            }
                            "result" if result.is_none() => {
                                job.running()?;
                                result = Some(event["payload"].clone());
                                if browser {
                                    worker.child.stdin.take();
                                }
                            }
                            "error" => {
                                return Err(text(&event, "message").chars().take(500).collect())
                            }
                            "cancelled" => return Err("TASK_CANCELLED".into()),
                            _ => return Err("RUNTIME_PROTOCOL_ERROR".into()),
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // The reader owns EOF: never consume a queued protocol message here.
                    }
                }
            }
            job.running()?;
            let until = Instant::now() + Duration::from_secs(2);
            loop {
                job.running()?;
                if let Some(status) = worker.child.try_wait().map_err(|_| "采集进程状态不可用")?
                {
                    if !status.success() {
                        return Err("RUNTIME_UNEXPECTED_EXIT".into());
                    }
                    break;
                }
                if Instant::now() > until {
                    return Err("RUNTIME_UNEXPECTED_EXIT".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            result.ok_or_else(|| "RUNTIME_UNEXPECTED_EXIT".into())
        })();
        drop(worker);
        operation
    }
}
