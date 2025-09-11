import os
import sqlite3


def print_db_tables(db_path: str):
    """Print all table names and structures in the SQLite database"""
    print(f"\n🔍 Checking database file: {db_path}")

    if not os.path.exists(db_path):
        print(f"❌ File does not exist! Path: {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # List all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    if not tables:
        print("❌ Database is empty, no tables created")
    else:
        print(f"✅ Database contains {len(tables)} table(s):")
        for (table_name,) in tables:
            print(f"  📂 Table name: {table_name}")

            # Print table structure
            cursor.execute(f"PRAGMA table_info({table_name});")
            columns = cursor.fetchall()
            print("    🧩 Structure:")
            for col in columns:
                print(f"      {col[1]} ({col[2]}) {'(PK)' if col[5] else ''}")

    conn.close()
