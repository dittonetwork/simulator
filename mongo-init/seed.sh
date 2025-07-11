#!/bin/bash
set -e
for file in /mongo_seed/*.csv; do
  [ -e "$file" ] || continue
  fname="$(basename "$file")"
  IFS='.' read -r db collection _ <<< "$fname"
  echo "Importing $file into $db.$collection"
  mongoimport --host localhost --port 27017 --type csv --headerline --drop --db "$db" --collection "$collection" --file "$file"
  echo "Imported $file"
done 