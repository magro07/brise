//! Versiegelt einen Skill-Ordner: seal_pack <ordner> <ziel.pack>, Passwort über stdin.

use std::collections::BTreeMap;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut password = String::new();
    std::io::stdin().read_line(&mut password).unwrap();
    let mut files = BTreeMap::new();
    for entry in std::fs::read_dir(&args[1]).unwrap().flatten() {
        if entry.path().is_file() {
            files.insert(entry.file_name().to_string_lossy().into_owned(), std::fs::read(entry.path()).unwrap());
        }
    }
    std::fs::write(&args[2], brise_lib::pack::seal(password.trim_end(), &files).unwrap()).unwrap();
}
