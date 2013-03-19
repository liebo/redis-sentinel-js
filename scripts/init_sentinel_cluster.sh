if [ -z "$1" ]
then
    echo 'Requires an argument indicating the number of sentinels to launch'
    exit 1
fi
prevdir=`pwd`
cd $(dirname $0)
num_sentinels=$1
i="0"
port="26379"
pkill redis-server

trap "pkill redis-server; wait" SIGINT SIGTERM

while [ $i -lt $num_sentinels ]
do
    redis-server sentinel_config.conf --port $port --sentinel&
    i=`expr $i + 1`
    port=`expr $port + 1`
done

for file in redis_configs/*
do
    filebase=$(basename $file)
    redis-server $file --dir `pwd`/redis_dumps --dbfilename "${filebase/.conf/.rdb}"&
done

cd $prevdir
wait
