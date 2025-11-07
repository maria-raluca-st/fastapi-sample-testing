from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os


mysql_user = os.environ.get('MYSQL_USER', 'user')
mysql_password = os.environ.get('MYSQL_PASSWORD', 'password')
mysql_host = os.environ.get('MYSQL_HOST', 'localhost')
mysql_db = os.environ.get('MYSQL_DATABASE', 'test_db')

# Create engine with connection pool settings for better reliability
try:
    engine = create_engine(
        f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}/{mysql_db}",
        pool_pre_ping=True,  # Verify connections before using
        pool_recycle=3600,   # Recycle connections after 1 hour
        connect_args={"connect_timeout": 5}  # 5 second timeout
    )
except Exception as e:
    print(f"Warning: Could not create database engine: {e}")
    engine = None

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine) if engine else None

Base = declarative_base()
